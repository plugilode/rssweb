import { type NextRequest, NextResponse } from "next/server"
import * as cheerio from "cheerio"
import RSS from "rss"
import { GoogleGenerativeAI } from "@google/generative-ai"

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "")

async function crawlSubpages(baseUrl: string, maxPages = 25): Promise<string[]> {
  const urls = [baseUrl]
  const visitedUrls = new Set([baseUrl])
  const domain = new URL(baseUrl).origin

  try {
    // Fetch the main page to find links
    const response = await fetch(baseUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS-Converter/1.0)",
      },
    })

    if (!response.ok) return [baseUrl]

    const html = await response.text()
    const $ = cheerio.load(html)

    // Find internal links
    const links: string[] = []
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
          !href.match(/\.(pdf|jpg|png|gif|zip|doc|docx)$/i) &&
          !href.includes("#") &&
          !href.includes("mailto:") &&
          !href.includes("tel:")
        ) {
          links.push(href)
          visitedUrls.add(href)
        }
      }
    })

    // Add up to maxPages-1 more URLs (since we already have the base URL)
    urls.push(...links.slice(0, maxPages - 1))
  } catch (error) {
    console.error("Error crawling subpages:", error)
  }

  return urls
}

export async function POST(request: NextRequest) {
  try {
    const { url, selectors, feedTitle, maxItems, maxSubpages = 25 } = await request.json()

    if (!url) {
      return NextResponse.json({ success: false, error: "URL is required" })
    }

    const urlsToCrawl = await crawlSubpages(url, maxSubpages)

    // Always use AI to detect selectors if not provided or if they're empty
    let finalSelectors = selectors
    if (
      !selectors ||
      !selectors.item ||
      !selectors.title ||
      !selectors.link ||
      selectors.item.trim() === "" ||
      selectors.title.trim() === "" ||
      selectors.link.trim() === ""
    ) {
      const mainPageResponse = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; RSS-Converter/1.0)",
        },
      })

      if (mainPageResponse.ok) {
        const mainPageHtml = await mainPageResponse.text()
        const cleanedHtml = prepareHtmlForAI(cheerio.load(mainPageHtml))
        finalSelectors = await detectContentWithGemini(cleanedHtml, url)
      } else {
        finalSelectors = fallbackDetection()
      }
    }

    // Extract items from all pages
    const allItems: any[] = []

    for (const pageUrl of urlsToCrawl) {
      try {
        const pageResponse = await fetch(pageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; RSS-Converter/1.0)",
          },
        })

        if (!pageResponse.ok) continue

        const pageHtml = await pageResponse.text()
        const page$ = cheerio.load(pageHtml)

        // Extract items from this page
        const pageItems: any[] = []
        const itemElements = page$(finalSelectors.item)

        itemElements.each((index, element) => {
          const $item = page$(element)

          // Extract title
          const titleEl = $item.find(finalSelectors.title).first()
          const title = titleEl.text().trim() || `Item from ${new URL(pageUrl).pathname}`

          // Extract link
          const linkEl = $item.find(finalSelectors.link).first()
          let link = linkEl.attr("href") || linkEl.attr("data-href") || ""

          // Make link absolute
          if (link && !link.startsWith("http")) {
            const basePageUrl = new URL(pageUrl)
            if (link.startsWith("/")) {
              link = basePageUrl.origin + link
            } else {
              link = basePageUrl.origin + "/" + link
            }
          }

          // Extract description
          let description = ""
          if (finalSelectors.description) {
            const descEl = $item.find(finalSelectors.description).first()
            description = descEl.text().trim().substring(0, 300)
          }

          if (title && link) {
            pageItems.push({
              title,
              link,
              description,
              pubDate: new Date().toISOString(),
              sourcePage: pageUrl,
            })
          }
        })

        allItems.push(...pageItems)

        // Add small delay between requests
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (error) {
        console.error(`Error processing page ${pageUrl}:`, error)
        continue
      }
    }

    // Remove duplicates based on link
    const uniqueItems = allItems.filter(
      (item, index, self) => index === self.findIndex((other) => other.link === item.link),
    )

    // Sort by title and limit to maxItems
    const items = uniqueItems.sort((a, b) => a.title.localeCompare(b.title)).slice(0, maxItems)

    // Create RSS feed
    const feed = new RSS({
      title: feedTitle || "RSS Feed",
      description: `RSS feed generated from ${url}`,
      feed_url: `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/feed/${Date.now()}`,
      site_url: url,
      language: "en",
    })

    const mainPageResponse = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS-Converter/1.0)",
      },
    })

    if (mainPageResponse.ok) {
      const mainPageHtml = await mainPageResponse.text()
      const mainPage$ = cheerio.load(mainPageHtml)
      feed.title(feedTitle || mainPage$("title").text() || "RSS Feed")
    }

    items.forEach((item) => {
      feed.item({
        title: item.title,
        description: item.description,
        url: item.link,
        date: item.pubDate,
      })
    })

    const xml = feed.xml()
    const feedId = Date.now().toString()
    const feedUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"}/api/feed/${feedId}`

    // In a real app, you'd store this feed in a database
    // For now, we'll just return the data

    return NextResponse.json({
      success: true,
      preview: {
        title: feedTitle || "RSS Feed",
        description: `RSS feed generated from ${url}`,
        items,
      },
      xml,
      feedUrl,
      pagesCrawled: urlsToCrawl.length,
      totalItemsFound: allItems.length,
    })
  } catch (error) {
    console.error("Feed generation error:", error)
    return NextResponse.json({ success: false, error: "Feed generation failed" })
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
    item: "article, .post, .entry, .item, .card, .listing, .product, .shop, .company, .result, .content-item, .grid-item, .list-item, [class*='item'], [class*='card'], [class*='post'], [class*='entry']",
    title:
      "h1, h2, h3, h4, .title, .headline, .name, .subject, a, .link-title, [class*='title'], [class*='name'], [class*='headline']",
    link: "a[href], .link, [href], .url, .read-more",
    description:
      "p, .excerpt, .summary, .description, .content, .text, .body, .intro, [class*='desc'], [class*='summary'], [class*='excerpt']",
  }
}
