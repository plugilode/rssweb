import { type NextRequest, NextResponse } from "next/server"
import Groq from "groq-sdk"

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
})

export async function POST(request: NextRequest) {
  try {
    const { items, title, url } = await request.json()

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ success: false, error: "Items are required" })
    }

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `
You are an expert web designer. You are given a list of articles (in JSON format) and you need to create a single HTML page that displays them in a classic newspaper layout.

- The page should have a main headline (the title of the feed).
- The articles should be arranged in a multi-column layout.
- Each article should have a headline, a short description, and a link to the original source.
- Use inline CSS for styling to ensure the styles are self-contained.
- The design should be clean, readable, and reminiscent of a classic newspaper.
- The entire output should be a single HTML file.
- Do not include any javascript or external assets.

Here is the data for the newspaper:
- Title: ${title}
- Source URL: ${url}
- Articles: ${JSON.stringify(items)}

Return ONLY the HTML code, no additional text or explanation.
`,
        },
      ],
      model: "llama3-8b-8192",
      temperature: 0.2,
      max_tokens: 4096,
      top_p: 1,
      stream: false,
    })

    const html = chatCompletion.choices[0]?.message?.content
    if (!html) {
      throw new Error("Empty response from Groq API")
    }

    return NextResponse.json({ success: true, html })
  } catch (error) {
    console.error("Newspaper generation error:", error)
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred"
    return NextResponse.json({ success: false, error: `Newspaper generation failed: ${errorMessage}` })
  }
}
