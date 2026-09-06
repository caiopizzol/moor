import { expect, test } from "bun:test";

test("shipped Compose keeps the admin port on loopback", async () => {
  const compose = Bun.YAML.parse(
    await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text(),
  ) as {
    services: {
      moor: {
        network_mode?: string;
        ports: Array<string | { target: number | string; host_ip?: string; protocol?: string }>;
      };
    };
  };
  const moor = compose.services.moor;
  expect(moor.network_mode).not.toBe("host");

  const ports = moor.ports.map((port) => {
    if (typeof port !== "string") return port;
    // Require an explicit host; brackets preserve IPv6 in Compose short syntax.
    const match = /^(\[[^\]]+\]|[^:]+):(\d+):(\d+)(?:\/(tcp|udp))?$/.exec(port);
    expect(match, `Expected an explicit host binding: ${port}`).not.toBeNull();
    return {
      host_ip: match![1]!.replace(/^\[|\]$/g, ""),
      target: match![3]!,
      protocol: match![4] ?? "tcp",
    };
  });

  for (const port of ports) {
    expect(String(port.target)).toMatch(/^\d+$/);
  }
  const adminPorts = ports.filter((port) => Number(port.target) === 3000);
  expect(adminPorts.length).toBeGreaterThan(0);
  for (const port of adminPorts) {
    expect(port.protocol ?? "tcp").toBe("tcp");
    expect(port.host_ip === "127.0.0.1" || port.host_ip === "::1").toBe(true);
  }
});
