import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

interface RawResponse {
  status: number;
  body: string;
}

/**
 * Codex CLI/Desktop and this suite's other lifecycle tests talk to the bridge with `fetch`, which
 * cannot set a forbidden `Host`/`Origin` header. A raw socket is the only way to reproduce a
 * DNS-rebound or cross-origin browser request's actual wire headers.
 */
function sendRawRequest(port: number, headerLines: string[]): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write([
        "GET /healthz HTTP/1.1",
        ...headerLines,
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
    });
    let raw = "";
    socket.on("data", chunk => { raw += chunk.toString(); });
    socket.on("error", reject);
    socket.on("close", () => {
      const statusLine = raw.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.split(" ")[1]);
      const bodyStart = raw.indexOf("\r\n\r\n");
      resolve({ status, body: bodyStart === -1 ? "" : raw.slice(bodyStart + 4) });
    });
  });
}

test("the local bridge accepts loopback Host headers with no Origin, matching Codex CLI/Desktop", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  try {
    expect((await sendRawRequest(port, [`Host: 127.0.0.1:${port}`])).status).toBe(200);
    expect((await sendRawRequest(port, [`Host: localhost:${port}`])).status).toBe(200);
    expect((await sendRawRequest(port, [`Host: [::1]:${port}`])).status).toBe(200);
    // A hand-built request that omits the port is accepted on hostname alone.
    expect((await sendRawRequest(port, ["Host: 127.0.0.1"])).status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("the local bridge accepts a browser request whose Origin matches this loopback bridge", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  try {
    const response = await sendRawRequest(port, [
      `Host: 127.0.0.1:${port}`,
      `Origin: http://127.0.0.1:${port}`,
    ]);
    expect(response.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("the local bridge rejects a DNS-rebound Host header", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  try {
    const response = await sendRawRequest(port, [`Host: attacker.example.com:${port}`]);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error.message).toBe("Request Host or Origin is not allowed");
  } finally {
    await server.stop(true);
  }
});

test("the local bridge rejects a Host header naming this port on the wrong hostname", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  try {
    const response = await sendRawRequest(port, [`Host: 127.0.0.1.attacker.example.com:${port}`]);
    expect(response.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("the local bridge rejects a loopback Host with a mismatched port", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  try {
    const response = await sendRawRequest(port, [`Host: 127.0.0.1:${port + 1}`]);
    expect(response.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});

test("the local bridge rejects a cross-origin browser request even with a loopback Host", async () => {
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  try {
    const response = await sendRawRequest(port, [
      `Host: 127.0.0.1:${port}`,
      "Origin: http://attacker.example.com",
    ]);
    expect(response.status).toBe(403);
  } finally {
    await server.stop(true);
  }
});
