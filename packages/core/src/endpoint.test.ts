import { describe, expect, it } from "vitest";
import { isPrivateOrReservedHost } from "@llm-router/core";

// AUD-ENDPOINT-001 — regras de prefixo IPv6 não podem ser aplicadas a nomes DNS.
// O discriminador é simples: todo literal IPv6 contém ":"; nenhum hostname DNS contém.

describe("AUD-ENDPOINT-001 — classificação de host", () => {
  it("não classifica nomes DNS como privados por causa do prefixo", () => {
    // VERMELHO hoje: as quatro retornam true porque caem nas regras de prefixo IPv6.
    for (const hostname of [
      "feature.example.com",
      "fdn.acme.io",
      "fc-gateway.corp.com",
      "ffmpeg-api.example.com",
      "fe80-cdn.example.com",
      "ff.example.org",
    ])
      expect(isPrivateOrReservedHost(hostname), hostname).toBe(false);
  });

  it("continua bloqueando literais IPv4 privados e reservados", () => {
    for (const hostname of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
    ])
      expect(isPrivateOrReservedHost(hostname), hostname).toBe(true);
  });

  it("continua bloqueando literais IPv6 privados e reservados", () => {
    for (const hostname of [
      "::1",
      "::",
      "fd00::1",
      "fc00::1",
      "fe80::1",
      "[fd00::1]",
      "::ffff:169.254.169.254",
      "ff02::1",
    ])
      expect(isPrivateOrReservedHost(hostname), hostname).toBe(true);
  });

  it("continua liberando hosts públicos", () => {
    for (const hostname of [
      "api.openai.com",
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
      "openrouter.ai",
      "8.8.8.8",
    ])
      expect(isPrivateOrReservedHost(hostname), hostname).toBe(false);
  });

  it("trata localhost e sufixo .localhost como reservados", () => {
    expect(isPrivateOrReservedHost("localhost")).toBe(true);
    expect(isPrivateOrReservedHost("api.localhost")).toBe(true);
  });
});
