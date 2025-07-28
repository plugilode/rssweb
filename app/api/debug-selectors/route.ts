import { type NextRequest, NextResponse } from "next/server"
import * as cheerio from "cheerio"
import { GoogleGenerativeAI } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")

async function crawlSubpages(url: string, maxPages = 5): Promise<string[]> {
  const subpages: string[] = []
  const visited = new Set<string>()
  const queue: string[] = [url]

  while (queue.length > 0 && subpages.length < maxPages) {
    const currentUrl = queue.shift()!

    if (visited.has(currentUrl)) {
      continue
    }

    visited.add(currentUrl)

    try {
      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; RSS-Converter/1.0)",
        },
      })

      if (!response.ok) {
        console.warn(`Failed to fetch ${currentUrl}: ${response.status} ${response.statusText}`)
        continue
      }

      const contentType = response.headers.get("content-type")
      if (!contentType?.includes("text/html")) {
        console.warn(`Skipping non-HTML page: ${currentUrl} (${contentType})`)
        continue
      }

      const html = await response.text()
      const $ = cheerio.load(html)

      // Extract links
      $("a[href]").each((_, a) => {
        const href = $(a).attr("href")
        if (href) {
          const absoluteUrl = new URL(href, currentUrl).href
          if (absoluteUrl.startsWith(url) && !visited.has(absoluteUrl)) {
            queue.push(absoluteUrl)
          }
        }
      })

      subpages.push(currentUrl)
    } catch (error) {
      console.error(`Error crawling ${currentUrl}:`, error)
    }
  }

  return subpages
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json()

    if (!url) {
      return NextResponse.json({ success: false, error: "URL is required" })
    }

    // Fetch the webpage
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS-Converter/1.0)",
      },
    })

    if (!response.ok) {
      return NextResponse.json({
        success: false,
        url,
        error: `Failed to fetch webpage: ${response.status} ${response.statusText}`,
      })
    }

    const html = await response.text()
    const $ = cheerio.load(html)

    const subpages = await crawlSubpages(url, 5)

    // Clean and prepare HTML for analysis
    const cleanedHtml = prepareHtmlForAI($)

    // Get a preview of the HTML structure
    const htmlPreview = getHtmlStructurePreview($)

    // Use Gemini AI to detect content patterns
    const selectors = await detectContentWithGemini(cleanedHtml, url)

    // Test the selectors and see what we actually find
    const testResults = testSelectors($, selectors)

    // Generate suggestions based on the HTML structure
    const suggestions = generateSuggestions($, selectors, testResults)

    return NextResponse.json({
      success: true,
      url,
      selectors,
      htmlPreview,
      itemsFound: testResults.itemCount,
      sampleItems: testResults.sampleItems,
      suggestions,
      subpagesCrawled: subpages.length,
      subpageUrls: subpages.slice(0, 3),
    })
  } catch (error) {
    console.error("Debug error:", error)
    return NextResponse.json({
      success: false,
      url: request.url,
      error: error instanceof Error ? error.message : "Debug failed",
    })
  }
}

function prepareHtmlForAI($: cheerio.CheerioAPI): string {
  // Remove script tags, style tags, and comments
  $("script, style, noscript").remove()

  // Get the main content area, prioritizing semantic elements
  let mainContent =
    $("main").html() || $("article").parent().html() || $(".content, .main, #content, #main").html() || $("body").html()

  // Truncate to reasonable length for AI processing
  if (mainContent && mainContent.length > 8000) {
    mainContent = mainContent.substring(0, 8000) + "..."
  }

  return mainContent || ""
}

function getHtmlStructurePreview($: cheerio.CheerioAPI): string {
  // Get a clean preview of the HTML structure
  $("script, style, noscript").remove()

  // Focus on the main content area
  const mainContent = $("main").length ? $("main") : $("body")

  // Get first 2000 characters of cleaned HTML
  let preview = mainContent.html() || ""
  if (preview.length > 2000) {
    preview = preview.substring(0, 2000) + "..."
  }

  return preview
}

async function detectContentWithGemini(html: string, url: string) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

    const prompt = `
You are an expert web scraper analyzing HTML to create RSS feeds. Analyze this HTML content from ${url} and suggest the best CSS selectors for extracting RSS feed items.

HTML Content:
${html}

Please analyze the HTML structure and provide CSS selectors in this exact JSON format:
{
  "item": "CSS selector for each content item/article",
  "title": "CSS selector for the title within each item",
  "link": "CSS selector for the link within each item", 
  "description": "CSS selector for description/excerpt within each item (can be empty string if none)"
}

Guidelines:
1. Look for repeating content patterns (articles, posts, news items, products, etc.)
2. The "item" selector should target the container of each piece of content
3. The "title", "link", and "description" selectors should work WITHIN each item container
4. Prefer semantic HTML elements when available (article, h1-h6, a, p)
5. If no clear description is available, return empty string for description
6. Make selectors as specific as needed but not overly complex
7. Ensure selectors will work with jQuery/Cheerio syntax
8. For e-commerce sites, look for product cards, shop items, or listings
9. For German sites like Trusted Shops, look for shop listings or company entries

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

      if (!selectors.item || !selectors.title || !selectors.link) {
        throw new Error("Invalid selector response from AI")
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

function testSelectors($: cheerio.CheerioAPI, selectors: any) {
  const items: any[] = []

  try {
    const itemElements = $(selectors.item) // Remove .slice(0, 5) to get all items

    itemElements.each((index, element) => {
      const $item = $(element)

      // Extract title
      const titleEl = $item.find(selectors.title).first()
      const title = titleEl.text().trim() || titleEl.attr("title") || titleEl.attr("alt") || `Item ${index + 1}`

      // Extract link
      const linkEl = $item.find(selectors.link).first()
      const link = linkEl.attr("href") || linkEl.attr("data-href") || $item.attr("href") || ""

      // Extract description
      let description = ""
      if (selectors.description) {
        const descEl = $item.find(selectors.description).first()
        description = descEl.text().trim().substring(0, 200)
      }

      items.push({
        title,
        link,
        description,
        rawHtml: $item.html()?.substring(0, 300) + "...", // For debugging
      })
    })

    return {
      itemCount: itemElements.length,
      sampleItems: items, // Return all items, not just first 5
    }
  } catch (error) {
    return {
      itemCount: 0,
      sampleItems: [],
      error: error instanceof Error ? error.message : "Selector test failed",
    }
  }
}

function generateSuggestions($: cheerio.CheerioAPI, selectors: any, testResults: any): string[] {
  const suggestions: string[] = []

  // Check if items were found
  if (testResults.itemCount === 0) {
    suggestions.push("No items found with the current selectors. The AI may have misidentified the content structure.")

    // Look for common patterns
    const commonSelectors = [
      "article",
      ".article",
      ".post",
      ".item",
      ".product",
      ".shop",
      ".listing",
      ".card",
      ".entry",
      ".result",
      ".company",
      ".store",
      '[data-testid*="item"]',
      ".grid-item",
      ".list-item",
      ".content-item",
    ]

    for (const selector of commonSelectors) {
      const count = $(selector).length
      if (count > 0) {
        suggestions.push(`Found ${count} elements with selector "${selector}" - consider using this instead`)
      }
    }
  }

  // Check for German-specific patterns (for Trusted Shops)
  const germanPatterns = [".shop-item", ".unternehmen", ".firma", ".geschäft", ".anbieter"]
  for (const pattern of germanPatterns) {
    const count = $(pattern).length
    if (count > 0) {
      suggestions.push(`German site detected: Found ${count} elements with "${pattern}"`)
    }
  }

  // Check if links are working
  if (testResults.sampleItems?.some((item: any) => !item.link)) {
    suggestions.push(
      "Some items are missing links. Try a different link selector or check if links are in parent elements.",
    )
  }

  // Check if titles are meaningful
  if (testResults.sampleItems?.some((item: any) => item.title.startsWith("Item "))) {
    suggestions.push("Generic titles detected. The title selector may not be finding the actual content titles.")
  }

  return suggestions
}

function fallbackDetection() {
  return {
    item: "article, .post, .entry, .item, .product, .shop, .listing, .card",
    title: "h1, h2, h3, .title, .headline, a, .name",
    link: "a[href]",
    description: "p, .excerpt, .summary, .description, .content",
  }
}
