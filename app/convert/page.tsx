"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Loader2,
  Globe,
  Brain,
  Download,
  Copy,
  ExternalLink,
  Rss,
  ArrowLeft,
  AlertCircle,
  Eye,
  BarChart3,
  Camera,
  Zap,
  Info,
} from "lucide-react"
import Link from "next/link"

interface ContentItem {
  id: string
  title: string
  link: string
  description: string
  sourcePage: string
  selected: boolean
  confidence?: string
}

interface FeedPreview {
  title: string
  description: string
  items: ContentItem[]
}

interface CrawlStats {
  totalItems: number
  uniqueItems: number
  duplicatesRemoved: number
}

export default function ConvertPage() {
  const [mounted, setMounted] = useState(false)
  const [url, setUrl] = useState("")
  const [feedTitle, setFeedTitle] = useState("")
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [previewItems, setPreviewItems] = useState<ContentItem[]>([])
  const [feedPreview, setFeedPreview] = useState<FeedPreview | null>(null)
  const [feedXml, setFeedXml] = useState("")
  const [feedUrl, setFeedUrl] = useState("")
  const [newspaperHtml, setNewspaperHtml] = useState("")
  const [error, setError] = useState<string>("")
  const [step, setStep] = useState<"input" | "preview" | "generated">("input")
  const [crawlStats, setCrawlStats] = useState<CrawlStats | null>(null)
  const [pagesCrawled, setPagesCrawled] = useState(0)
  const [totalPagesFound, setTotalPagesFound] = useState(0)
  const [analysisMethod, setAnalysisMethod] = useState<string>("")

  useEffect(() => {
    setMounted(true)
  }, [])

  const handleScrapeWebsite = async () => {
    if (!url) return

    setError("")
    setLoading(true)
    setStep("input")
    setCrawlStats(null)
    setPagesCrawled(0)
    setTotalPagesFound(0)

    try {
      const response = await fetch("/api/preview-content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })

      const data = await response.json()

      if (data.success) {
        setPreviewItems(data.items)
        setFeedTitle(data.suggestedTitle || "")
        setStep("preview")
        setError("")
        setCrawlStats(data.stats)
        setPagesCrawled(data.pagesCrawled)
        setTotalPagesFound(data.totalPagesFound)
        setAnalysisMethod("traditional")
      } else {
        setError(data.error)
      }
    } catch (error) {
      console.error("Scraping failed:", error)
      const errorMessage = error instanceof Error ? error.message : "Network error occurred"
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }

  const handleGenerateRSS = async () => {
    const selectedItems = previewItems.filter((item) => item.selected)

    if (selectedItems.length === 0) {
      setError("Please select at least one item to include in the RSS feed")
      return
    }

    setError("")
    setGenerating(true)

    try {
      const response = await fetch("/api/generate-selected-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          selectedItems,
          feedTitle: feedTitle || "Custom RSS Feed",
        }),
      })

      const data = await response.json()

      if (data.success) {
        setFeedPreview(data.preview)
        setFeedXml(data.xml)
        setFeedUrl(data.feedUrl)
        setStep("generated")
        setError("")
        handleGenerateNewspaper(data.preview.items, data.preview.title)
      } else {
        setError(data.error)
      }
    } catch (error) {
      console.error("RSS generation failed:", error)
      const errorMessage = error instanceof Error ? error.message : "Network error occurred"
      setError(errorMessage)
    } finally {
      setGenerating(false)
    }
  }

  const handleGenerateNewspaper = async (items: ContentItem[], title: string) => {
    try {
      const response = await fetch("/api/generate-newspaper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          title,
          url,
        }),
      })
      const data = await response.json()
      if (data.success) {
        setNewspaperHtml(data.html)
      }
    } catch (error) {
      console.error("Newspaper generation failed:", error)
    }
  }

  const toggleItemSelection = (itemId: string) => {
    setPreviewItems((items) => items.map((item) => (item.id === itemId ? { ...item, selected: !item.selected } : item)))
  }

  const selectAll = () => {
    setPreviewItems((items) => items.map((item) => ({ ...item, selected: true })))
  }

  const deselectAll = () => {
    setPreviewItems((items) => items.map((item) => ({ ...item, selected: false })))
  }

  const selectBySourcePage = (sourcePage: string, selected: boolean) => {
    setPreviewItems((items) => items.map((item) => (item.sourcePage === sourcePage ? { ...item, selected } : item)))
  }

  const copyFeedUrl = () => {
    if (mounted && navigator.clipboard) {
      navigator.clipboard.writeText(feedUrl)
    }
  }

  const downloadXml = () => {
    if (!mounted) return

    const blob = new Blob([feedXml], { type: "application/xml" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "feed.xml"
    a.click()
    URL.revokeObjectURL(url)
  }

  const resetToInput = () => {
    setStep("input")
    setPreviewItems([])
    setFeedPreview(null)
    setError("")
    setCrawlStats(null)
    setScreenshot("")
    setVisionAnalysis(null)
    setDetectedSelectors(null)
    setAnalysisMethod("")
  }

  // Group items by source page for better organization
  const itemsByPage = previewItems.reduce(
    (acc, item) => {
      if (!acc[item.sourcePage]) {
        acc[item.sourcePage] = []
      }
      acc[item.sourcePage].push(item)
      return acc
    },
    {} as Record<string, ContentItem[]>,
  )

  if (!mounted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-teal-500" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <Link href="/" className="flex items-center space-x-2 text-gray-600 hover:text-gray-900">
              <ArrowLeft className="h-5 w-5" />
              <span>Back</span>
            </Link>
            <div className="flex items-center space-x-2">
              <Rss className="h-6 w-6 text-teal-500" />
              <span className="text-lg font-semibold text-gray-900">RSS Converter</span>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Convert Website to RSS</h1>
            <p className="text-gray-600">
              {step === "input" && "Enter a URL to begin scraping for content"}
              {step === "preview" && "Select the items you want to include in your RSS feed"}
              {step === "generated" && "Your RSS feed has been generated successfully"}
            </p>
          </div>

          {error && (
            <Alert className="mb-6 border-red-200 bg-red-50">
              <AlertCircle className="h-4 w-4 text-red-600" />
              <AlertDescription className="text-red-800">
                <strong>Error:</strong> {error}
              </AlertDescription>
            </Alert>
          )}

          {/* Step 1: Input URL */}
          {step === "input" && (
            <div className="max-w-2xl mx-auto">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center space-x-2">
                    <Globe className="h-5 w-5 text-teal-500" />
                    <span>Website URL</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="url">Enter the website URL you want to convert</Label>
                    <Input
                      id="url"
                      type="url"
                      placeholder="https://example.com"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      className="mt-1"
                    />
                  </div>

                  <p className="text-sm text-gray-500">
                    Enter a website URL to automatically detect content and generate an RSS feed.
                  </p>

                  <Button
                    onClick={handleScrapeWebsite}
                    disabled={!url || loading}
                    className="w-full bg-teal-500 hover:bg-teal-600 text-white py-3"
                    size="lg"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Scraping Website & Subpages...
                      </>
                    ) : (
                      <>
                        <Eye className="mr-2 h-5 w-5" />
                        Scrape & Preview
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 2: Preview and Select Items */}
          {step === "preview" && (
            <div className="space-y-6">
              {/* Stats Card */}
              {crawlStats && (
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <BarChart3 className="h-5 w-5 text-blue-500" />
                      <span>Crawl Statistics</span>
                      {analysisMethod && (
                        <Badge
                          variant="secondary"
                          className={
                            analysisMethod === "traditional"
                              ? "bg-teal-100 text-teal-800"
                              : "bg-purple-100 text-purple-800"
                          }
                        >
                          {analysisMethod === "traditional" ? "Traditional" : "AI-Guided"}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-blue-600">{pagesCrawled}</div>
                        <div className="text-sm text-gray-600">Pages Crawled</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-green-600">{crawlStats.uniqueItems}</div>
                        <div className="text-sm text-gray-600">Unique Items</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-orange-600">{crawlStats.totalItems}</div>
                        <div className="text-sm text-gray-600">Total Found</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold text-red-600">{crawlStats.duplicatesRemoved}</div>
                        <div className="text-sm text-gray-600">Duplicates Removed</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Brain className="h-5 w-5 text-teal-500" />
                      <span>Content Preview</span>
                      <Badge variant="secondary">{previewItems.length} items found</Badge>
                    </div>
                    <Button variant="outline" onClick={resetToInput} size="sm">
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      Back to URL
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="feedTitle">Feed Title</Label>
                    <Input
                      id="feedTitle"
                      placeholder="My Custom RSS Feed"
                      value={feedTitle}
                      onChange={(e) => setFeedTitle(e.target.value)}
                      className="mt-1"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2 items-center">
                    <Button variant="outline" size="sm" onClick={selectAll}>
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" onClick={deselectAll}>
                      Deselect All
                    </Button>
                    <Badge variant="secondary" className="ml-auto">
                      {previewItems.filter((item) => item.selected).length} selected
                    </Badge>
                  </div>

                  <div className="max-h-96 overflow-y-auto space-y-4 border rounded-lg p-4">
                    {Object.entries(itemsByPage).map(([sourcePage, items]) => (
                      <div key={sourcePage} className="space-y-2">
                        <div className="flex items-center justify-between bg-gray-100 p-2 rounded">
                          <div className="flex items-center space-x-2">
                            <h4 className="font-medium text-sm text-gray-700">{new URL(sourcePage).pathname || "/"}</h4>
                            <Badge variant="outline" className="text-xs">
                              {items.length} items
                            </Badge>
                          </div>
                          <div className="flex space-x-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => selectBySourcePage(sourcePage, true)}
                              className="text-xs h-6 px-2"
                            >
                              Select All
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => selectBySourcePage(sourcePage, false)}
                              className="text-xs h-6 px-2"
                            >
                              Deselect All
                            </Button>
                          </div>
                        </div>

                        <div className="space-y-2 ml-4">
                          {items.map((item) => (
                            <div
                              key={item.id}
                              className={`flex items-start space-x-3 p-3 rounded-lg border ${
                                item.selected ? "bg-teal-50 border-teal-200" : "bg-white border-gray-200"
                              }`}
                            >
                              <Checkbox
                                checked={item.selected}
                                onCheckedChange={() => toggleItemSelection(item.id)}
                                className="mt-1"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center space-x-2 mb-1">
                                  <h5 className="font-medium text-gray-900 line-clamp-2">{item.title}</h5>
                                  {item.confidence && (
                                    <Badge
                                      variant={item.confidence === "high" ? "default" : "secondary"}
                                      className="text-xs"
                                    >
                                      {item.confidence}
                                    </Badge>
                                  )}
                                </div>
                                {item.description && (
                                  <p className="text-sm text-gray-600 mb-2 line-clamp-2">{item.description}</p>
                                )}
                                <div className="flex items-center justify-between text-xs text-gray-500">
                                  <span className="truncate">{item.link}</span>
                                  <a
                                    href={item.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center hover:text-teal-600 ml-2"
                                  >
                                    <ExternalLink className="h-3 w-3 mr-1" />
                                    View
                                  </a>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <Button
                    onClick={handleGenerateRSS}
                    disabled={generating || previewItems.filter((item) => item.selected).length === 0}
                    className="w-full bg-teal-500 hover:bg-teal-600 text-white py-3"
                    size="lg"
                  >
                    {generating ? (
                      <>
                        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                        Generating RSS Feed...
                      </>
                    ) : (
                      <>
                        <Rss className="mr-2 h-5 w-5" />
                        Generate RSS Feed ({previewItems.filter((item) => item.selected).length} items)
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Step 4: Generated Feed */}
          {step === "generated" && feedPreview && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>RSS Feed Generated</span>
                    <div className="flex space-x-2">
                      <Button variant="outline" onClick={resetToInput} size="sm">
                        Create New Feed
                      </Button>
                      <Button variant="outline" size="sm" onClick={copyFeedUrl} className="bg-transparent">
                        <Copy className="mr-1 h-3 w-3" />
                        Copy URL
                      </Button>
                      <Button variant="outline" size="sm" onClick={downloadXml} className="bg-transparent">
                        <Download className="mr-1 h-3 w-3" />
                        Download
                      </Button>
                    </div>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="preview" className="w-full">
                    <TabsList className="grid w-full grid-cols-3">
                      <TabsTrigger value="preview">Preview</TabsTrigger>
                      <TabsTrigger value="xml">Raw XML</TabsTrigger>
                      <TabsTrigger value="newspaper">Newspaper</TabsTrigger>
                    </TabsList>

                    <TabsContent value="preview" className="space-y-4 mt-4">
                      <div className="border-b pb-4">
                        <h3 className="font-semibold text-lg">{feedPreview.title}</h3>
                        <p className="text-gray-600 text-sm">{feedPreview.description}</p>
                        <Badge variant="secondary" className="mt-2">
                          {feedPreview.items.length} items
                        </Badge>
                      </div>

                      <div className="space-y-4 max-h-96 overflow-y-auto">
                        {feedPreview.items.map((item, index) => (
                          <div key={index} className="border-l-4 border-teal-500 pl-4 py-2">
                            <h4 className="font-medium text-gray-900 mb-1">{item.title}</h4>
                            {item.description && <p className="text-gray-600 text-sm mb-2">{item.description}</p>}
                            <div className="flex items-center justify-between text-xs text-gray-500">
                              <span>{new Date().toLocaleDateString()}</span>
                              <a
                                href={item.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center hover:text-teal-600"
                              >
                                <ExternalLink className="h-3 w-3 mr-1" />
                                View
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    </TabsContent>

                    <TabsContent value="xml" className="mt-4">
                      <Textarea value={feedXml} readOnly className="font-mono text-xs h-96 resize-none" />
                    </TabsContent>

                    <TabsContent value="newspaper" className="mt-4">
                      {newspaperHtml ? (
                        <iframe
                          srcDoc={newspaperHtml}
                          className="w-full h-96 border rounded-lg"
                          title="Newspaper Preview"
                        />
                      ) : (
                        <div className="flex items-center justify-center h-96 border rounded-lg">
                          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
