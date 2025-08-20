import { type NextRequest, NextResponse } from "next/server"
import { GoogleGenerativeAI } from "@google/generative-ai"
import * as cheerio from "cheerio"

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set in the environment variables")
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY)

const SCREENSHOT_API_KEY = process.env.SCREENSHOT_API_KEY || ""

// Check if we're in a serverless environment where Puppeteer might not work
const isServerlessEnvironment = process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME

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

    console.log(`Starting vision analysis for: ${url}`)

    // Try different screenshot methods based on environment
    let screenshotResult

    if (isServerlessEnvironment) {
      console.log("Serverless environment detected, using screenshot service")
      screenshotResult = await getScreenshotViaService(url)
    } else {
      console.log("Attempting Puppeteer screenshot")
      screenshotResult = await getScreenshotViaPuppeteer(url)
    }

    if (!screenshotResult.success) {
      console.log("Screenshot failed, falling back to HTML-only analysis")
      return await performHtmlOnlyAnalysis(url)
    }

    console.log("Screenshot obtained, analyzing with AI...")

    // Use Gemini Vision to analyze the screenshot
    let analysisResult
    try {
      analysisResult = await analyzeScreenshotWithGemini(screenshotResult.screenshot, url, screenshotResult.pageTitle)
    } catch (visionError) {
      console.error("Vision analysis failed:", visionError)
      return await performHtmlOnlyAnalysis(url)
    }

    // Get HTML structure for selector generation
    const html = await fetchPageHtml(url)
    const $ = cheerio.load(html)
    const cleanedHtml = prepareHtmlForAI($)

    // Generate selectors based on AI analysis
    let selectors
    try {
      selectors = await generateSelectorsFromAnalysis(cleanedHtml, analysisResult, url)
    } catch (selectorError) {
      console.error("Selector generation failed:", selectorError)
      selectors = fallbackDetection()
    }

    return NextResponse.json({
      success: true,
      screenshot: screenshotResult.screenshot,
      analysis: analysisResult,
      selectors,
      pageTitle: screenshotResult.pageTitle,
      url,
      method: screenshotResult.method,
    })
  } catch (error) {
    console.error("Vision analysis error:", error)

    // Always return JSON, never let the error bubble up as HTML
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Vision analysis failed due to an unexpected error",
      fallbackAvailable: true,
    })
  }
}

async function getScreenshotViaPuppeteer(url: string) {
  try {
    // Dynamic import to handle environments where Puppeteer isn't available
    const puppeteer = await import("puppeteer").catch(() => null)

    if (!puppeteer) {
      throw new Error("Puppeteer not available")
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
      ],
    })

    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    )

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    })

    await page.waitForTimeout(3000)

    const screenshot = await page.screenshot({
      fullPage: true,
      type: "png",
    })

    const pageTitle = await page.title()
    await browser.close()

    return {
      success: true,
      screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
      pageTitle,
      method: "puppeteer",
    }
  } catch (error) {
    console.error("Puppeteer screenshot failed:", error)
    return { success: false, error: error instanceof Error ? error.message : "Puppeteer failed" }
  }
}

async function getScreenshotViaService(url: string) {
  try {
    if (!SCREENSHOT_API_KEY) {
      console.warn("SCREENSHOT_API_KEY is not set, using demo key.")
    }
    const apiKey = SCREENSHOT_API_KEY || "demo"

    // Use a free screenshot service API
    const screenshotUrl = `https://api.screenshotmachine.com/?key=${apiKey}&url=${encodeURIComponent(
      url,
    )}&dimension=1920x1080&format=png&cacheLimit=0`

    const response = await fetch(screenshotUrl, {
      timeout: 30000,
    })

    if (!response.ok) {
      throw new Error(`Screenshot service returned ${response.status}`)
    }

    const imageBuffer = await response.arrayBuffer()
    const base64Screenshot = Buffer.from(imageBuffer).toString("base64")

    // Get page title separately
    const pageHtml = await fetchPageHtml(url)
    const $ = cheerio.load(pageHtml)
    const pageTitle = $("title").text() || "Unknown Page"

    return {
      success: true,
      screenshot: `data:image/png;base64,${base64Screenshot}`,
      pageTitle,
      method: "service",
    }
  } catch (error) {
    console.error("Screenshot service failed:", error)
    return { success: false, error: error instanceof Error ? error.message : "Screenshot service failed" }
  }
}

async function performHtmlOnlyAnalysis(url: string) {
  try {
    console.log("Performing HTML-only analysis as fallback")

    const html = await fetchPageHtml(url)
    const $ = cheerio.load(html)
    const pageTitle = $("title").text() || "Unknown Page"

    // Create a mock analysis based on HTML structure
    const analysisResult = await analyzeHtmlStructure($, url)

    // Generate selectors based on HTML analysis
    const cleanedHtml = prepareHtmlForAI($)
    const selectors = await generateSelectorsFromHtmlAnalysis(cleanedHtml, url)

    return NextResponse.json({
      success: true,
      screenshot: null, // No screenshot available
      analysis: analysisResult,
      selectors,
      pageTitle,
      url,
      method: "html-only",
      note: "Vision analysis not available - using HTML structure analysis instead",
    })
  } catch (error) {
    console.error("HTML-only analysis failed:", error)
    return NextResponse.json({
      success: false,
      error: "Both vision and HTML analysis failed",
      fallbackAvailable: false,
    })
  }
}

async function fetchPageHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`)
  }

  return await response.text()
}

async function analyzeHtmlStructure($: cheerio.CheerioAPI, url: string) {
  // Analyze HTML structure to determine content type and patterns
  const articles = $("article").length
  const posts = $(".post, .entry").length
  const products = $(".product, .item").length
  const cards = $(".card").length

  let contentType = "unknown"
  let layoutType = "mixed"

  if (articles > 0) {
    contentType = "blog"
    layoutType = "list"
  } else if (products > 0) {
    contentType = "ecommerce"
    layoutType = "grid"
  } else if (posts > 0) {
    contentType = "news"
    layoutType = "list"
  } else if (cards > 0) {
    contentType = "mixed"
    layoutType = "cards"
  }

  return {
    contentType,
    mainContentAreas: [
      {
        description: `Detected ${articles + posts + products + cards} potential content items`,
        location: "main content area",
        importance: "high",
        contentPattern: `${contentType} items in ${layoutType} layout`,
      },
    ],
    recommendedFocus: `Focus on ${contentType} content extraction`,
    layoutType,
    excludeAreas: ["navigation", "sidebar", "footer", "ads"],
    confidence: "medium",
    method: "html-structure-analysis",
  }
}

async function generateSelectorsFromHtmlAnalysis(html: string, url: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

    const prompt = `
You are an expert web scraper. Analyze this HTML structure and generate the best CSS selectors for extracting RSS feed content.

HTML STRUCTURE:
${html}

Generate CSS selectors that target repeating content patterns suitable for RSS feeds.

Provide selectors in this exact JSON format:
{
  "item": "CSS selector for each content item/article container",
  "title": "CSS selector for the title within each item",
  "link": "CSS selector for the link within each item",
  "description": "CSS selector for description/excerpt within each item (can be empty string if none)",
  "confidence": "high/medium/low",
  "reasoning": "Brief explanation of why these selectors were chosen"
}

Guidelines:
1. Look for repeating content patterns (articles, posts, news items, products, listings, etc.)
2. Prioritize semantic HTML elements when available
3. Make selectors specific enough to target the right content but not overly complex
4. Avoid navigation, sidebar, footer, or ad content

Return ONLY the JSON object, no additional text.
`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const text = response.text()

    try {
      let cleanedText = text.trim()
      if (cleanedText.startsWith("```json")) {
        cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "")
      } else if (cleanedText.startsWith("```")) {
        cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "")
      }

      const selectors = JSON.parse(cleanedText)

      if (
        !selectors.item ||
        !selectors.title ||
        !selectors.link ||
        selectors.item.trim() === "" ||
        selectors.title.trim() === "" ||
        selectors.link.trim() === ""
      ) {
        return fallbackDetection()
      }

      return selectors
    } catch (parseError) {
      console.error("Failed to parse HTML analysis selector response:", text)
      return fallbackDetection()
    }
  } catch (error) {
    console.error("HTML analysis selector generation error:", error)
    return fallbackDetection()
  }
}

async function analyzeScreenshotWithGemini(screenshotBase64: string, url: string, pageTitle: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

    const prompt = `
You are an expert web content analyst. Analyze this screenshot of the website "${pageTitle}" (${url}) and identify the most important content areas that would be valuable for an RSS feed.

Please analyze the visual layout and identify:

1. **Main Content Areas**: Where are the primary articles, posts, news items, or products located?
2. **Content Patterns**: What type of repeating content blocks do you see? (articles, cards, listings, etc.)
3. **Navigation Elements**: Identify headers, sidebars, footers that should be excluded
4. **Content Hierarchy**: What appears to be the most important content vs secondary content?
5. **Layout Structure**: Describe the overall layout (grid, list, cards, etc.)

Focus on identifying content that would be suitable for RSS feeds such as:
- News articles
- Blog posts  
- Product listings
- Event listings
- Job postings
- Forum posts
- Any other regularly updated content

Provide your analysis in this JSON format:
{
  "contentType": "Type of content (news, blog, ecommerce, forum, etc.)",
  "mainContentAreas": [
    {
      "description": "Description of content area",
      "location": "Visual location (top-left, center, etc.)",
      "importance": "high/medium/low",
      "contentPattern": "Description of repeating pattern"
    }
  ],
  "recommendedFocus": "What content should be prioritized for RSS",
  "layoutType": "grid/list/cards/mixed",
  "excludeAreas": ["Areas to avoid like navigation, ads, etc."],
  "confidence": "high/medium/low - how confident you are in this analysis"
}

Return ONLY the JSON object, no additional text or explanation.
`

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: screenshotBase64.replace("data:image/png;base64,", ""),
          mimeType: "image/png",
        },
      },
    ])

    const response = await result.response
    const text = response.text()

    if (!text || text.trim().length === 0) {
      throw new Error("Empty response from Gemini Vision API")
    }

    try {
      let cleanedText = text.trim()
      if (cleanedText.startsWith("```json")) {
        cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "")
      } else if (cleanedText.startsWith("```")) {
        cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "")
      }

      const analysis = JSON.parse(cleanedText)

      if (!analysis.contentType || !analysis.mainContentAreas || !Array.isArray(analysis.mainContentAreas)) {
        throw new Error("Invalid analysis structure from AI")
      }

      return analysis
    } catch (parseError) {
      console.error("Failed to parse vision analysis:", text)
      return {
        contentType: "unknown",
        mainContentAreas: [
          {
            description: "Unable to analyze content areas from screenshot",
            location: "unknown",
            importance: "medium",
            contentPattern: "unknown",
          },
        ],
        recommendedFocus: "General content extraction using fallback methods",
        layoutType: "mixed",
        excludeAreas: ["navigation", "sidebar", "footer", "ads"],
        confidence: "low",
        error: "Failed to parse AI vision analysis",
      }
    }
  } catch (error) {
    console.error("Gemini Vision API error:", error)
    throw new Error(`Vision analysis failed: ${error instanceof Error ? error.message : "Unknown API error"}`)
  }
}

async function generateSelectorsFromAnalysis(html: string, analysis: any, url: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

    const prompt = `
You are an expert web scraper. Based on the visual analysis of the website and the HTML structure, generate the best CSS selectors for extracting RSS feed content.

VISUAL ANALYSIS RESULTS:
- Content Type: ${analysis.contentType}
- Layout Type: ${analysis.layoutType}
- Main Content Areas: ${JSON.stringify(analysis.mainContentAreas)}
- Recommended Focus: ${analysis.recommendedFocus}
- Areas to Exclude: ${JSON.stringify(analysis.excludeAreas)}

HTML STRUCTURE:
${html}

Based on the visual analysis, the content appears to be ${analysis.contentType} with a ${analysis.layoutType} layout. 
The main content areas are: ${analysis.mainContentAreas.map((area: any) => area.description).join(", ")}.

Generate CSS selectors that target the content identified in the visual analysis. Focus on the high-importance areas and avoid the excluded areas.

Provide selectors in this exact JSON format:
{
  "item": "CSS selector for each content item/article container",
  "title": "CSS selector for the title within each item",
  "link": "CSS selector for the link within each item",
  "description": "CSS selector for description/excerpt within each item (can be empty string if none)",
  "confidence": "high/medium/low",
  "reasoning": "Brief explanation of why these selectors were chosen based on the visual analysis"
}

Guidelines:
1. Use the visual analysis to focus on the most important content areas
2. Avoid selectors that would target navigation, sidebar, footer, or ads
3. Prioritize semantic HTML elements when available
4. Make selectors specific enough to target the right content but not overly complex
5. Consider the layout type (${analysis.layoutType}) when choosing selectors
6. Target content patterns identified in the visual analysis

Return ONLY the JSON object, no additional text.
`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const text = response.text()

    if (!text || text.trim().length === 0) {
      throw new Error("Empty response from selector generation")
    }

    try {
      let cleanedText = text.trim()
      if (cleanedText.startsWith("```json")) {
        cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "")
      } else if (cleanedText.startsWith("```")) {
        cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "")
      }

      const selectors = JSON.parse(cleanedText)

      if (
        !selectors.item ||
        !selectors.title ||
        !selectors.link ||
        selectors.item.trim() === "" ||
        selectors.title.trim() === "" ||
        selectors.link.trim() === ""
      ) {
        console.warn("AI returned invalid selectors, using fallback")
        return fallbackDetection()
      }

      return selectors
    } catch (parseError) {
      console.error("Failed to parse selector response:", text)
      return fallbackDetection()
    }
  } catch (error) {
    console.error("Selector generation error:", error)
    return fallbackDetection()
  }
}

function prepareHtmlForAI($: cheerio.CheerioAPI): string {
  $("script, style, noscript").remove()

  let mainContent =
    $("main").html() || $("article").parent().html() || $(".content, .main, #content, #main").html() || $("body").html()

  if (mainContent && mainContent.length > 10000) {
    mainContent = mainContent.substring(0, 10000) + "..."
  }

  return mainContent || ""
}

function fallbackDetection() {
  return {
    item: "article, .post, .entry, .item, .card, .listing, .product, .shop, .company, .result, .content-item, .grid-item, .list-item, [class*='item'], [class*='card'], [class*='post'], [class*='entry']",
    title:
      "h1, h2, h3, h4, .title, .headline, .name, .subject, a, .link-title, [class*='title'], [class*='name'], [class*='headline']",
    link: "a[href], .link, [href], .url, .read-more",
    description:
      "p, .excerpt, .summary, .description, .content, .text, .body, .intro, [class*='desc'], [class*='summary'], [class*='excerpt']",
    confidence: "low",
    reasoning: "Fallback selectors used due to analysis failure",
  }
}
