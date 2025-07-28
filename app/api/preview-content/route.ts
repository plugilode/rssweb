import { type NextRequest, NextResponse } from "next/server"
import * as cheerio from "cheerio"
import { GoogleGenerativeAI } from "@google/generative-ai"
import { getGeminiApiKey } from "@/lib/getGeminiKey"

const genAI = new GoogleGenerativeAI(getGeminiApiKey())

async function findPaginationLinks($: cheerio.CheerioAPI, baseUrl: string): Promise<string[]> {
  const paginationUrls: string[] = []
  const domain = new URL(baseUrl).origin

  // Common pagination selectors
  const paginationSelectors = [
    'a[href*="page"]',
    'a[href*="p="]',
    'a[href*="offset"]',
    'a[href*="start"]',
    ".pagination a",
    ".pager a",
    ".page-numbers a",
    'a[rel="next"]',
    'a[aria-label*="next"]',
    'a[aria-label*="page"]',
    ".next a",
    ".more a",
    'a[href*="/2"]',
    'a[href*="/3"]',
    'a[href*="/4"]',
    'a[href*="/5"]',
  ]

  for (const selector of paginationSelectors) {
    $(selector).each((_, element) => {
      let href = $(element).attr("href")
      if (!href) return

      // Make absolute URL
      if (href.startsWith("/")) {
        href = domain + href
      } else if (!href.startsWith("http")) {
        href = new URL(href, baseUrl).href
      }

      // Only include same-domain links
      if (href.startsWith(domain) && !paginationUrls.includes(href)) {
        paginationUrls.push(href)
      }
    })
  }

  // Generate numbered pagination URLs (common pattern)
  const urlObj = new URL(baseUrl)
  const patterns = [
    `${urlObj.origin}${urlObj.pathname}?page=`,
    `${urlObj.origin}${urlObj.pathname}?p=`,
    `${urlObj.origin}${urlObj.pathname}/page/`,
    `${urlObj.origin}${urlObj.pathname}/p/`,
    `${baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"}page/`,
  ]

  for (const pattern of patterns) {
    for (let i = 2; i <= 10; i++) {
      const paginationUrl = pattern + i
      if (!paginationUrls.includes(paginationUrl)) {
        paginationUrls.push(paginationUrl)
      }
    }
  }

  return paginationUrls.slice(0, 20) // Limit pagination URLs
}

async function crawlSubpages(baseUrl: string, maxPages = 50): Promise<string[]> {
  const urls = [baseUrl]
  const visitedUrls = new Set([baseUrl])
  const domain = new URL(baseUrl).origin
  const processedUrls: string[] = []

  try {
    // First, get the main page
    const response = await fetch(baseUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    })

    if (!response.ok) return [baseUrl]

    const html = await response.text()
    const $ = cheerio.load(html)

    // Find pagination links first
    const paginationUrls = await findPaginationLinks($, baseUrl)
    console.log(`Found ${paginationUrls.length} pagination URLs`)

    // Add pagination URLs to the queue with higher priority
    for (const paginationUrl of paginationUrls) {
      if (!visitedUrls.has(paginationUrl)) {
        urls.push(paginationUrl)
        visitedUrls.add(paginationUrl)
      }
    }

    // Find regular internal links
    const regularLinks: string[] = []
    $("a[href]").each((_, element) => {
      let href = $(element).attr("href")
      if (!href) return

      // Make absolute URLs
      if (href.startsWith("/")) {
        href = domain + href
      } else if (!href.startsWith("http")) {
        href = new URL(href, baseUrl).href
      }

      // Only include same-domain links
      if (href.startsWith(domain) && !visitedUrls.has(href)) {
        // Exclude common non-content URLs
        if (
          !href.match(/\.(pdf|jpg|png|gif|zip|doc|docx|css|js)$/i) &&
          !href.includes("#") &&
          !href.includes("mailto:") &&
          !href.includes("tel:") &&
          !href.includes("javascript:") &&
          !href.match(/\/(login|register|cart|checkout|admin|api)/i)
        ) {
          regularLinks.push(href)
          visitedUrls.add(href)
        }
      }
    })

    // Add regular links after pagination links
    urls.push(...regularLinks.slice(0, maxPages - urls.length))

    // Limit to maxPages
    processedUrls.push(...urls.slice(0, maxPages))
  } catch (error) {
    console.error("Error crawling subpages:", error)
    return [baseUrl]
  }

  console.log(`Will crawl ${processedUrls.length} URLs total`)
  return processedUrls
}

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

    console.log(`Starting to crawl: ${url}`)

    // Get subpages to crawl (up to 50)
    const urlsToCrawl = await crawlSubpages(url, 50)
    console.log(`Found ${urlsToCrawl.length} URLs to crawl`)

    // Detect selectors using AI from the main page
    const mainPageResponse = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    })

    if (!mainPageResponse.ok) {
      return NextResponse.json({
        success: false,
        error: `Website returned ${mainPageResponse.status} ${mainPageResponse.statusText}`,
      })
    }

    const mainPageHtml = await mainPageResponse.text()
    const mainPage$ = cheerio.load(mainPageHtml)

    const cleanedHtml = prepareHtmlForAI(mainPage$)
    const selectors = await detectContentWithGemini(cleanedHtml, url)
    const pageTitle = mainPage$("title").text() || mainPage$("h1").first().text() || "RSS Feed"

    console.log("Detected selectors:", selectors)

    // Extract preview items from all pages
    const allItems: any[] = []
    let processedCount = 0

    for (const pageUrl of urlsToCrawl) {
      try {
        console.log(`Processing page ${processedCount + 1}/${urlsToCrawl.length}: ${pageUrl}`)

        const pageResponse = await fetch(pageUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Cache-Control": "no-cache",
          },
          // Add timeout for individual pages
          signal: AbortSignal.timeout(15000), // 15 second timeout per page
        })

        if (!pageResponse.ok) {
          console.warn(`Failed to fetch ${pageUrl}: ${pageResponse.status}`)
          continue
        }

        const contentType = pageResponse.headers.get("content-type")
        if (!contentType?.includes("text/html")) {
          console.warn(`Skipping non-HTML page: ${pageUrl}`)
          continue
        }

        const pageHtml = await pageResponse.text()
        const page$ = cheerio.load(pageHtml)

        const itemElements = page$(selectors.item)
        console.log(`Found ${itemElements.length} items on ${pageUrl}`)

        itemElements.each((index, element) => {
          const $item = page$(element)

          const titleEl = $item.find(selectors.title).first()
          const title =
            titleEl.text().trim() ||
            titleEl.attr("title") ||
            titleEl.attr("alt") ||
            `Item from ${new URL(pageUrl).pathname}`

          const linkEl = $item.find(selectors.link).first()
          let link = linkEl.attr("href") || linkEl.attr("data-href") || $item.find("a").first().attr("href") || ""

          // Make link absolute
          if (link && !link.startsWith("http")) {
            const basePageUrl = new URL(pageUrl)
            if (link.startsWith("/")) {
              link = basePageUrl.origin + link
            } else {
              link = new URL(link, pageUrl).href
            }
          }

          let description = ""
          if (selectors.description) {
            const descEl = $item.find(selectors.description).first()
            description = descEl.text().trim().substring(0, 300)
          }

          // Only add items with valid title and link
          if (title && link && title.length > 3) {
            allItems.push({
              id: `${pageUrl}-${index}-${Date.now()}`,
              title: title.substring(0, 200), // Limit title length
              link,
              description,
              sourcePage: pageUrl,
              selected: true, // Default to selected
            })
          }
        })

        processedCount++

        // Add delay between requests to be respectful
        await new Promise((resolve) => setTimeout(resolve, 200))
      } catch (error) {
        console.error(`Error processing page ${pageUrl}:`, error)
        continue
      }
    }

    console.log(`Total items found: ${allItems.length}`)

    // Remove duplicates based on link and title
    const uniqueItems = allItems.filter((item, index, self) => {
      return (
        index ===
        self.findIndex((other) => other.link === item.link || (other.title === item.title && other.link === item.link))
      )
    })

    console.log(`Unique items after deduplication: ${uniqueItems.length}`)

    // Sort by title for better organization
    const sortedItems = uniqueItems.sort((a, b) => a.title.localeCompare(b.title))

    return NextResponse.json({
      success: true,
      selectors,
      suggestedTitle: pageTitle,
      items: sortedItems,
      pagesCrawled: processedCount,
      totalPagesFound: urlsToCrawl.length,
      stats: {
        totalItems: allItems.length,
        uniqueItems: uniqueItems.length,
        duplicatesRemoved: allItems.length - uniqueItems.length,
      },
    })
  } catch (error) {
    console.error("Preview content error:", error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to preview content",
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
11. Consider pagination - selectors should work across multiple pages with similar structure

Return ONLY the JSON object, no additional text or explanation.
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
      console.error("Failed to parse AI response:", text)
      return fallbackDetection()
    }
  } catch (error) {
    console.error("Gemini AI error:", error)
    return fallbackDetection()
  }
}

function prepareHtmlForAI($: cheerio.CheerioAPI): string {
  $("script, style, noscript").remove()

  let mainContent =
    $("main").html() || $("article").parent().html() || $(".content, .main, #content, #main").html() || $("body").html()

  if (mainContent && mainContent.length > 8000) {
    mainContent = mainContent.substring(0, 8000) + "..."
  }

  return mainContent || ""
}

function fallbackDetection() {
  return {
    item: "article, .post, .entry, .item, .card, .listing, .product, .shop, .company, .result, .content-item, .grid-item, .list-item, [class*='item'], [class*='card'], [class*='post'], [class*='entry'], .news-item, .story, .content-block",
    title:
      "h1, h2, h3, h4, .title, .headline, .name, .subject, a, .link-title, [class*='title'], [class*='name'], [class*='headline'], .entry-title, .post-title",
    link: "a[href], .link, [href], .url, .read-more, .permalink",
    description:
      "p, .excerpt, .summary, .description, .content, .text, .body, .intro, [class*='desc'], [class*='summary'], [class*='excerpt'], .entry-content, .post-content",
  }
}
