"use strict";

var assert = require("assert");
var api = require("./location-spoofer.js");

function bytes(values) {
  return Array.prototype.slice.call(values);
}

function oracleSignedVarint(value) {
  var current = BigInt(value);
  if (current < 0n) {
    current = BigInt.asUintN(64, current);
  }
  var out = [];
  while (current >= 0x80n) {
    out.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  out.push(Number(current));
  return out;
}

function makeLocation(latitude, longitude) {
  return api.concatBytes([
    api.makeVarintField(1, api.coordToInt(latitude)),
    api.makeVarintField(2, api.coordToInt(longitude)),
    api.makeVarintField(3, 25),
    api.makeVarintField(5, 15)
  ]);
}

function makePayload(latitude, longitude) {
  var location = makeLocation(latitude, longitude);
  var wifi = api.concatBytes([
    api.makeLengthDelimitedField(1, api.binaryStringToBytes("00:11:22:33:44:55")),
    api.makeLengthDelimitedField(2, location)
  ]);
  var cell = api.makeLengthDelimitedField(5, location);
  return api.concatBytes([
    api.makeLengthDelimitedField(2, wifi),
    api.makeLengthDelimitedField(22, cell)
  ]);
}

function quantizedCoordinate(value) {
  return (api.coordToInt(value) / 100000000).toFixed(8);
}

function expectedSummary(latitude, longitude) {
  var pair = quantizedCoordinate(latitude) + "," + quantizedCoordinate(longitude);
  return "firstWifi=" + pair + ", firstCell=" + pair;
}

[
  0,
  1,
  127,
  128,
  4294967295,
  4294967296,
  18000000000,
  -1,
  -12200902000,
  -18000000000
].forEach(function (value) {
  assert.deepStrictEqual(
    bytes(api.encodeVarintSignedInt64(value)),
    oracleSignedVarint(value),
    "signed varint mismatch for " + value
  );
});

var syntheticPayload = makePayload(22.544577, 113.94114);
var syntheticResponse = api.buildAppleWLocResponse(syntheticPayload);
var syntheticResult = api.spoofAppleResponse(syntheticResponse, {
  latitude: 37.3349,
  longitude: -122.00902,
  horizontalAccuracy: 9,
  verticalAccuracy: 20,
  altitude: 15
});

assert.strictEqual(syntheticResult.kind, "synthetic");
assert.strictEqual(syntheticResult.wifiCount, 1);
assert.strictEqual(syntheticResult.cellCount, 1);
assert.strictEqual(
  api.patchedPayloadSummary(syntheticResult.payload),
  expectedSummary(37.3349, -122.00902)
);

var arpcResponse = api.serializeArpc({
  version: 1,
  locale: "en_US",
  appIdentifier: "com.apple.locationd",
  osVersion: "12.5.8",
  functionId: 1,
  payload: makePayload(-33.8688, 151.2093)
});
var arpcResult = api.spoofAppleResponse(arpcResponse, {
  latitude: -33.8688,
  longitude: 151.2093,
  horizontalAccuracy: 12,
  verticalAccuracy: 20,
  altitude: 40
});

assert.strictEqual(arpcResult.kind, "arpc");
assert.strictEqual(arpcResult.wifiCount, 1);
assert.strictEqual(arpcResult.cellCount, 1);
assert.strictEqual(
  api.patchedPayloadSummary(arpcResult.payload),
  expectedSummary(-33.8688, 151.2093)
);

console.log("iOS 12 compatibility tests passed");
