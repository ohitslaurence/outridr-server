import assert from "node:assert/strict";
import { test } from "node:test";

import { hostAllowed } from "../lib/http-util.mjs";

test("hostAllowed — accepts loopback, IPv4 literals, and MagicDNS names", () => {
  for (const host of [
    "localhost",
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:8080",
    "my-machine.tail1234.ts.net",
    "my-machine.tail1234.ts.net:443",
  ]) {
    assert.equal(hostAllowed(host), true, host);
  }
});

test("hostAllowed — accepts bracketless IPv6 literals (port-strip regression)", () => {
  // `.replace(/:\d+$/, "")` used to eat the final hextet of an unbracketed
  // IPv6 literal, wrongly 421'ing these on a tokenless server.
  for (const host of ["::1", "fe80::1", "2001:db8::1", "1:2:3:4:5:6:7:8"]) {
    assert.equal(hostAllowed(host), true, host);
  }
});

test("hostAllowed — accepts bracketed IPv6 literals with and without a port", () => {
  for (const host of ["[::1]", "[::1]:8080", "[fe80::1]:3000", "[2001:db8::1]"]) {
    assert.equal(hostAllowed(host), true, host);
  }
});

test("hostAllowed — rejects arbitrary and all-hex domains (DNS-rebinding)", () => {
  for (const host of [
    "evil.example",
    "dead.cafe",
    "beef.cafe",
    "example.com:80",
    "[::1",
    "[::1]evil",
    "[::1]@evil.com",
    "",
  ]) {
    assert.equal(hostAllowed(host), false, host);
  }
});
