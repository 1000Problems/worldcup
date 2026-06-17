import { NextResponse } from "next/server";

// CORS is also set globally in next.config.js; we mirror the preflight here so
// route handlers answer OPTIONS instead of 405-ing.
export function preflight() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}
