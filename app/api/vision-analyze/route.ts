import { type NextRequest, NextResponse } from "next/server"

export async function POST(request: NextRequest) {
  return NextResponse.json({
    success: false,
    error: "Vision analysis is not available when using the Groq API.",
    fallbackAvailable: true,
  })
}
