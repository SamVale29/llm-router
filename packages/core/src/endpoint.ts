export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIpv4Literal(host)) return isReservedIpv4(host);
  if (host.includes(":")) return isReservedIpv6(host);
  return false;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part));
}

function isReservedIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const first = octets[0] ?? -1;
  const second = octets[1];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && second !== undefined && second >= 18 && second <= 19) ||
    (first === 198 && second === 51) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  );
}

function isReservedIpv6(host: string): boolean {
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isIpv4Literal(mapped) ? isReservedIpv4(mapped) : true;
  }
  if (host === "::" || host === "::1") return true;
  const group = host.split(":")[0] ?? "";
  return /^f[cd]/.test(group) || /^fe[89ab]/.test(group) || /^ff/.test(group);
}
