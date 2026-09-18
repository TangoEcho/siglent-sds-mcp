import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import { SiglentConnection } from "../../src/connection.js";

/**
 * Fake scope on a local TCP port. Records each chunk it receives separately
 * and answers *OPC? only after a configurable "busy" delay, the way the real
 * scope does after a slow setting such as VDIV.
 */
async function startFakeScope(busyMs: number) {
  const chunks: string[] = [];
  const server = net.createServer((sock) => {
    sock.on("data", (buf) => {
      const text = buf.toString();
      chunks.push(text);
      for (const line of text.split("\n").filter(Boolean)) {
        if (line === "*IDN?") sock.write("Siglent,SDS1202X-E,TEST,1.3.27\n");
        if (line === "*OPC?") setTimeout(() => sock.write("1\n"), busyMs);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { server, port, chunks };
}

describe("SiglentConnection.sendCommand", () => {
  let scope: Awaited<ReturnType<typeof startFakeScope>>;
  let conn: SiglentConnection;

  beforeEach(async () => {
    scope = await startFakeScope(100);
    conn = new SiglentConnection();
    await conn.connect("127.0.0.1", scope.port);
    scope.chunks.length = 0;
  });

  afterEach(async () => {
    conn.disconnect();
    await new Promise((r) => scope.server.close(r));
  });

  it("waits for *OPC? before resolving", async () => {
    const t0 = Date.now();
    await conn.sendCommand("C2:VDIV 10mV");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it("sends the command and *OPC? as separate writes", async () => {
    // In one packet the scope mis-parses the command's numeric argument
    await conn.sendCommand("TDIV 50US");
    expect(scope.chunks).toEqual(["TDIV 50US\n", "*OPC?\n"]);
  });

  it("does not send the next command until the previous one completes", async () => {
    await Promise.all([
      conn.sendCommand("C2:VDIV 10mV"),
      conn.sendCommand("C2:OFST -30mV"),
    ]);
    expect(scope.chunks).toEqual([
      "C2:VDIV 10mV\n",
      "*OPC?\n",
      "C2:OFST -30mV\n",
      "*OPC?\n",
    ]);
  });
});
