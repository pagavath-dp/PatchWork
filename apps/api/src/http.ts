import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

function safePrismaDetails(error: unknown): Record<string, string> | null {
  if (typeof error !== "object" || error === null || !("code" in error) ||
    typeof error.code !== "string" || !/^P\d{4}$/.test(error.code)) return null;
  const details: Record<string, string> = { prismaCode: error.code };
  const descriptions: Record<string, string> = {
    P2010: "Raw database query failed", P2021: "Database table is missing", P2022: "Database column is missing",
  };
  if (Object.hasOwn(descriptions, error.code)) details.description = descriptions[error.code]!;
  const meta: Record<string, unknown> | null = "meta" in error && typeof error.meta === "object" && error.meta !== null
    ? error.meta as Record<string, unknown> : null;
  for (const key of ["modelName", "table", "column", "constraint"] as const) {
    if (meta && key in meta && typeof meta[key] === "string" && /^[A-Za-z0-9_."]{1,120}$/.test(meta[key])) {
      details[key] = meta[key];
    }
  }
  if (meta && "code" in meta && typeof meta.code === "string" && /^[A-Z0-9]{5}$/.test(meta.code)) {
    details.sqlState = meta.code;
  }
  return details;
}

export function sendError(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  void _next;
  if (error instanceof SyntaxError && "status" in error && error.status === 400) {
    response.status(400).json({ error: { code: "INVALID_JSON", message: "Invalid JSON body" } });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ error: { code: "INVALID_INPUT", message: "Invalid request", details: error.flatten() } });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
    return;
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
    response.status(409).json({ error: { code: "CONFLICT", message: "A record with this value already exists" } });
    return;
  }
  console.error("Request failed", { errorType: error instanceof Error ? error.constructor.name : "unknown error",
    ...safePrismaDetails(error) });
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
}

export function requireSameOrigin(appOrigin: string) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (request.get("origin") !== appOrigin) {
      next(new HttpError(403, "INVALID_ORIGIN", "Request origin is not allowed"));
      return;
    }
    next();
  };
}
