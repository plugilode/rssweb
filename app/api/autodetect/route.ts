import { type NextRequest, NextResponse } from "next/server"
import * as cheerio from "cheerio"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { getGeminiApiKey } from "@/lib/getGeminiKey"
import { AbortSignal } from "abort-controller"

const genAI = new GoogleGenerativeAI(getGeminiApiKey())

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json()

    if (!url) {
      return NextResponse.json({ success: false, error: "URL is required" })
    }

    // Validate URL format
    try {
      new URL(url)
    } catch {
      return NextResponse.json({ success: false, error: "Invalid URL format" })
    }

    // Fetch the webpage with better error handling
    let response
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          DNT: "1",
          Connection: "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
        // Add timeout
        signal: AbortSignal.timeout(30000), // 30 second timeout
      })
    } catch (fetchError) {
      console.error("Fetch error:", fetchError)

      // Provide more specific error messages
      if (fetchError instanceof Error) {
        if (fetchError.name === "TimeoutError") {
          return NextResponse.json({
            success: false,
            error: "Request timed out. The website may be slow or unreachable.",
          })
        }
        if (fetchError.message.includes("ENOTFOUND")) {
          return NextResponse.json({
            success: false,
            error: "Website not found. Please check the URL.",
          })
        }
        if (fetchError.message.includes("ECONNREFUSED")) {
          return NextResponse.json({
            success: false,
            error: "Connection refused. The website may be blocking requests.",
          })
        }
      }

      return NextResponse.json({
        success: false,
        error: "Failed to fetch webpage. The site may be blocking requests or temporarily unavailable.",
      })
    }

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        error: `Website returned ${response.status} ${response.statusText}`,
      })
    }

    // Check content type
    const contentType = response.headers.get("content-type")
    if (!contentType || !contentType.includes("text/html")) {
      return NextResponse.json({
        success: false,
        error: "URL does not point to an HTML page",
      })
    }

    const html = await response.text()

    if (!html || html.length < 100) {
      return NextResponse.json({
        success: false,
        error: "Received empty or very short response from website",
      })
    }

    const $ = cheerio.load(html)

    // Clean and prepare HTML for AI analysis
    const cleanedHtml = prepareHtmlForAI($)
    const pageTitle = $("title").text() || $("h1").first().text() || "RSS Feed"

    // Use Gemini AI to detect content patterns
    const selectors = await detectContentWithGemini(cleanedHtml, url)

    return NextResponse.json({
      success: true,
      selectors,
      suggestedTitle: pageTitle,
    })
  } catch (error) {
    console.error("Auto-detection error:", error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Auto-detection failed",
    })
  }
}

async function detectContentWithGemini(html: string, url: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

    const prompt = `
You are an expert web scraper analyzing HTML to create RSS feeds. Analyze this HTML content from ${url} and suggest the best CSS selectors for extracting RSS feed items.

HTML Content (truncated for analysis):
${html}

IMPORTANT: You must provide valid, non-empty CSS selectors. If you cannot find clear patterns, use common fallback selectors.

Please analyze the HTML structure and provide CSS selectors in this exact JSON format:
{
  "item": "CSS selector for each content item/article",
  "title": "CSS selector for the title within each item",
  "link": "CSS selector for the link within each item", 
  "description": "CSS selector for description/excerpt within each item (can be empty string if none)"
}

Guidelines:
1. Look for repeating content patterns (articles, posts, news items, products, listings, etc.)
2. The "item" selector should target the container of each piece of content
3. The "title", "link", and "description" selectors should work WITHIN each item container
4. Prefer semantic HTML elements when available (article, h1-h6, a, p)
5. If no clear description is available, return empty string for description
6. Make selectors as specific as needed but not overly complex
7. Ensure selectors will work with jQuery/Cheerio syntax
8. For e-commerce or directory sites, look for product cards, shop items, or company listings
9. Common patterns include: .item, .card, .listing, .product, .entry, .post, article
10. NEVER return empty strings for item, title, or link selectors - always provide fallback options

Examples of good selectors:
- item: "article, .item, .card, .listing, .product, .entry"
- title: "h1, h2, h3, .title, .name, a"
- link: "a[href], .link"

Return ONLY the JSON object, no additional text or explanation.
`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const text = response.text()

    try {
      // Remove markdown code block formatting if present
      let cleanedText = text.trim()
      if (cleanedText.startsWith("```json")) {
        cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "")
      } else if (cleanedText.startsWith("```")) {
        cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "")
      }

      const selectors = JSON.parse(cleanedText)

      // Validate that we have non-empty required selectors
      if (
        !selectors.item ||
        !selectors.title ||
        !selectors.link ||
        selectors.item.trim() === "" ||
        selectors.title.trim() === "" ||
        selectors.link.trim() === ""
      ) {
        console.warn("AI returned empty selectors, using fallback")
        return fallbackDetection()
      }

      return selectors
    } catch (parseError) {
      console.error("Failed to parse AI response:", text)
      return fallbackDetection()
    }
  } catch (error) {
    console.error("Gemini AI error:", error)
    return fallbackDetection()
  }
}

function prepareHtmlForAI($: cheerio.CheerioAPI): string {
  // Remove script tags, style tags, and comments
  $("script, style, noscript").remove()

  // Get the main content area, prioritizing semantic elements
  let mainContent =
    $("main").html() || $("article").parent().html() || $(".content, .main, #content, #main").html() || $("body").html()

  // Truncate to reasonable length for AI processing (first 8000 characters)
  if (mainContent && mainContent.length > 8000) {
    mainContent = mainContent.substring(0, 8000) + "..."
  }

  return mainContent || ""
}

function fallbackDetection() {
  // More comprehensive fallback patterns
  return {
    item: "article, .post, .entry, .item, .card, .listing, .product, .shop, .company, .result, .content-item, .grid-item, .list-item, [class*='item'], [class*='card'], [class*='post'], [class*='entry']",
    title:
      "h1, h2, h3, h4, .title, .headline, .name, .subject, a, .link-title, [class*='title'], [class*='name'], [class*='headline']",
    link: "a[href], .link, [href], .url, .read-more",
    description:
      "p, .excerpt, .summary, .description, .content, .text, .body, .intro, [class*='desc'], [class*='summary'], [class*='excerpt']",
  }
}
