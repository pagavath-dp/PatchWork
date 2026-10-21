import { describe, expect, it } from "vitest";
import { invitationStatusPresentation } from "./invitation-status";

describe("invitation status presentation", () => {
  it("gives each known status a readable label and distinct style", () => {
    const statuses = ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED", "REJECTED"];
    const presentations = statuses.map(invitationStatusPresentation);
    expect(presentations.map((item) => item.label)).toEqual(["Pending", "Accepted", "Expired", "Revoked", "Rejected"]);
    expect(new Set(presentations.map((item) => item.className)).size).toBe(statuses.length);
    expect(presentations.every((item) => item.className.includes("text-"))).toBe(true);
  });

  it("handles an unexpected status safely", () => {
    expect(invitationStatusPresentation("FUTURE_STATUS")).toMatchObject({ label: "Unknown status" });
  });
});
