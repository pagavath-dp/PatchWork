import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { sendError } from "../src/http.js";

describe("unexpected API error diagnostics", () => {
  it("logs safe Prisma codes and schema metadata without leaking error messages or arbitrary metadata", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const response = { status } as unknown as Response;
    const secret = "do-not-log-sensitive-value";
    try {
      sendError({ code: "P2021", message: secret, meta: { modelName: "TaskActivity",
        table: "public.TaskActivity", query: secret } }, {} as Request, response, (() => {}) as NextFunction);
      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });
      expect(log).toHaveBeenCalledWith("Request failed", { errorType: "unknown error", prismaCode: "P2021",
        description: "Database table is missing", modelName: "TaskActivity", table: "public.TaskActivity" });
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally { log.mockRestore(); }
  });

  it("reports a raw-query SQLSTATE without logging its raw message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const json = vi.fn();
    const response = { status: vi.fn(() => ({ json })) } as unknown as Response;
    try {
      sendError({ code: "P2010", message: "private SQL text", meta: { code: "42P01", message: "private SQL text" } },
        {} as Request, response, (() => {}) as NextFunction);
      expect(log).toHaveBeenCalledWith("Request failed", { errorType: "unknown error", prismaCode: "P2010",
        description: "Raw database query failed", sqlState: "42P01" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private SQL text");
    } finally { log.mockRestore(); }
  });
});
