import { describe, it, expect } from "vitest";
import { assertSafeProviderUrl, isPrivateAddress } from "../netGuard.js";

describe("isPrivateAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1"])("%s is private", (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("assertSafeProviderUrl", () => {
  const pub = async () => ["93.184.216.34"];
  it("accepts a public https host", async () => expect(await assertSafeProviderUrl("https://api.example.com/v1/", { lookup: pub })).toBe("https://api.example.com/v1"));
  it("rejects http, credentials, bad urls", async () => {
    await expect(assertSafeProviderUrl("http://api.example.com", { lookup: pub })).rejects.toThrow(/https/);
    await expect(assertSafeProviderUrl("https://u:p@api.example.com", { lookup: pub })).rejects.toThrow(/credentials/);
    await expect(assertSafeProviderUrl("not a url")).rejects.toThrow(/valid/);
  });
  it("rejects internal hosts, metadata IPs and DNS that points inside", async () => {
    for (const u of ["https://localhost/v1", "https://redis/v1", "https://svc.internal/v1", "https://169.254.169.254/latest", "https://10.0.0.5/v1", "https://[::1]/v1"]) await expect(assertSafeProviderUrl(u, { lookup: pub }), u).rejects.toThrow(/public/);
    await expect(assertSafeProviderUrl("https://evil.example.com", { lookup: async () => ["93.184.216.34", "10.0.0.7"] })).rejects.toThrow(/public/);
    await expect(assertSafeProviderUrl("https://nx.example.com", { lookup: async () => { throw new Error("ENOTFOUND"); } })).rejects.toThrow(/resolved/);
  });
  it("private networks only when the platform policy allows", async () => {
    expect(await assertSafeProviderUrl("http://10.0.0.5:8080/v1", { allowPrivate: true, allowHttp: true })).toBe("http://10.0.0.5:8080/v1");
  });
});
