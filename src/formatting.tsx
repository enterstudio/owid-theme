import * as cheerio from 'cheerio'
const urlSlug = require('url-slug')
const wpautop = require('wpautop')
import * as _ from 'lodash'
import * as React from 'react'
import * as ReactDOMServer from 'react-dom/server'
import {HTTPS_ONLY, WORDPRESS_URL, BAKED_DIR, BAKED_URL}  from './settings'
import { getTables, getUploadedImages, FullPost } from './wpdb'
import Tablepress from './views/Tablepress'
import {GrapherExports} from './grapherUtil'
import * as path from 'path'

const mjAPI = require("mathjax-node");

export interface FormattedPost {
    id: number
    type: 'post'|'page'
    slug: string
    title: string
    date: Date
    modifiedDate: Date
    authors: string[]
    html: string
    footnotes: string[]
    excerpt: string
    imageUrl?: string
    tocHeadings: { text: string, slug: string, isSubheading: boolean }[]
}

function romanize(num: number) {
	if (!+num)
		return "";
	var digits = String(+num).split(""),
		key = ["","C","CC","CCC","CD","D","DC","DCC","DCCC","CM",
				"","X","XX","XXX","XL","L","LX","LXX","LXXX","XC",
				"","I","II","III","IV","V","VI","VII","VIII","IX"],
		roman = "",
		i = 3;
	while (i--)
		roman = (key[+(digits.pop() as any) + (i * 10)] || "") + roman;
	return Array(+digits.join("") + 1).join("M") + roman;
}

mjAPI.config({
    MathJax: {
      // traditional MathJax configuration
    }
});
mjAPI.start();

function extractLatex(html: string): [string, string[]] {
    const latexBlocks: string[] = []
    html = html.replace(/\[latex\]([\s\S]*?)\[\/latex\]/gm, (_, latex) => {
        latexBlocks.push(latex.replace("\\[", "").replace("\\]", "").replace(/\$\$/g, ""))
        return "[latex]"
    })
    return [html, latexBlocks]
}

async function formatLatex(html: string, latexBlocks?: string[]): Promise<string> {
    if (!latexBlocks)
        [html, latexBlocks] = extractLatex(html)

    const compiled: string[] = []
    for (let latex of latexBlocks) {
        try {
            const result = await mjAPI.typeset({ math: latex, format: "TeX", svg: true })
            compiled.push(result.svg.replace("<svg", `<svg class="latex"`))
        } catch (err) {
            compiled.push(`${latex} (parse error: ${err})`)
        }
    }
    
    let i = -1
    return html.replace(/\[latex\]/g, _ => {
        i += 1
        return compiled[i]
    })
}

export async function formatWordpressPost(post: FullPost, html: string, grapherExports?: GrapherExports) {
    // Strip comments
    html = html.replace(/<!--[^>]+-->/g, "")
    
    // Standardize spacing
    html = html.replace(/&nbsp;/g, "").replace(/\r\n/g, "\n").replace(/\n+/g, "\n").replace(/\n/g, "\n\n")
    
    // Need to skirt around wordpress formatting to get proper latex rendering
    let latexBlocks
    [html, latexBlocks] = extractLatex(html)

    // Replicate wordpress formatting (thank gods there's an npm package)
    html = wpautop(html)

    html = await formatLatex(html, latexBlocks)

    // Footnotes
    const footnotes: string[] = []
    html = html.replace(/\[ref\]([\s\S]*?)\[\/ref\]/gm, (_, footnote) => {
        footnotes.push(footnote)
        const i = footnotes.length
        return `<a id="ref-${i}" class="ref" href="#note-${i}"><sup>${i}</sup></a>`
    })

    // Insert [table id=foo] tablepress tables
    const tables = await getTables()
    html = html.replace(/\[table\s+id=(\d+)\s*\/\]/g, (match, tableId) => {
        const table = tables.get(tableId)
        if (table)
            return ReactDOMServer.renderToStaticMarkup(<Tablepress data={table.data}/>)
        else
            return "UNKNOWN TABLE"
    })

    // These old things don't work with static generation, link them through to maxroser.com
    html = html.replace(new RegExp("https://ourworldindata.org/wp-content/uploads/nvd3", 'g'), "https://www.maxroser.com/owidUploads/nvd3")
            .replace(new RegExp("https://ourworldindata.org/wp-content/uploads/datamaps", 'g'), "https://www.maxroser.com/owidUploads/datamaps")

    const $ = cheerio.load(html)

    // Wrap content demarcated by headings into section blocks
    const sectionStarts = [$("body").children().get(0)].concat($("h2").toArray())
    for (const start of sectionStarts) {
        const $start = $(start)
        const $contents = $start.nextUntil("h2")
        const $wrapNode = $("<section></section>");

        $contents.remove();
        $wrapNode.append($start.clone())
        $wrapNode.append($contents)
        $start.replaceWith($wrapNode)
    }

    // Replace grapher iframes with static previews
    if (grapherExports) {
        const grapherIframes = $("iframe").toArray().filter(el => (el.attribs['src']||'').match(/\/grapher\//))
        for (const el of grapherIframes) {
            const src = el.attribs['src']
            const chart = grapherExports.get(src)
            if (chart) {
                const output = `<figure data-grapher-src="${src}" class="grapherPreview"><a href="${src}" target="_blank"><div><img src="${chart.svgUrl}"/></div></a></div>`
                const $p = $(el).closest('p')
                $(el).remove()
                $p.after(output)
            }
        }
    }

    // Any remaining iframes: ensure https embeds
    if (HTTPS_ONLY) {
        for (const iframe of $("iframe").toArray()) {
            iframe.attribs['src'] = iframe.attribs['src'].replace("http://", "https://")
        }
    }

    // Remove any empty elements
    for (const p of $("p").toArray()) {
        const $p = $(p)
        if ($p.contents().length === 0)
            $p.remove()
    }

    // Wrap tables so we can do overflow-x: scroll if needed
    for (const table of $("table").toArray()) {
        const $table = $(table)
        const $div = $("<div class='tableContainer'></div>")
        $table.after($div)
        $div.append($table)
    }

    // Image processing
    const uploadDex = await getUploadedImages()
    for (const el of $("img").toArray()) {
        const $el = $(el)

        // Open full-size image in new tab
        if (el.parent.tagName === "a") {
            el.parent.attribs['target'] = '_blank'
        }

        // Set srcset to load image responsively
        const src = el.attribs['src']||""
        const upload = uploadDex.get(path.basename(src))
        if (upload && upload.variants.length) {
            el.attribs['srcset'] = upload.variants.map(v => `${v.url} ${v.width}w`).join(", ")
            el.attribs['sizes'] = "(min-width: 800px) 50vw, 100vw"

            // Link through to full size image
            if (el.parent.tagName !== "a") {
                const $a = $(`<a href="${upload.originalUrl}" target="_blank"></a>`)
                $el.replaceWith($a)
                $a.append($el)
            }
        }
    }
    
    // Table of contents and deep links
    const hasToc = post.type === 'page' && post.slug !== 'about'
    let openHeadingIndex = 0
    let openSubheadingIndex = 0
    const tocHeadings: { text: string, slug: string, isSubheading: boolean }[] = []
    $("h1, h2, h3, h4").each((_, el) => {
        const $heading = $(el);
        const headingText = $heading.text()
        // We need both the text and the html because may contain footnote
        let headingHtml = $heading.html() as string
        const slug = urlSlug(headingText)

        // Table of contents
        if (hasToc) {
            if ($heading.is("#footnotes") && footnotes.length > 0) {
                tocHeadings.push({ text: headingText, slug: "footnotes", isSubheading: false })
            } else if (!$heading.is('h1') && !$heading.is('h4')) {
                // Inject numbering into the text as well
                if ($heading.is('h2')) {
                    openHeadingIndex += 1;
                    openSubheadingIndex = 0;
                } else if ($heading.is('h3')) {
                    openSubheadingIndex += 1;
                }
    
                if (openHeadingIndex > 0) {
                    if ($heading.is('h2')) {
                        headingHtml = romanize(openHeadingIndex) + '. ' + headingHtml;
                        $heading.html(headingHtml)
                        tocHeadings.push({ text: $heading.text(), slug: slug, isSubheading: false })
                    } else {
                        headingHtml = romanize(openHeadingIndex) + '.' + openSubheadingIndex + ' ' + headingHtml;
                        $heading.html(headingHtml)
                        tocHeadings.push({ text: $heading.text(), slug: slug, isSubheading: true })
                    }					
                }
            }    
        }

        // Deep link
        $heading.attr('id', slug).prepend(`<a class="deep-link" href="#${slug}"></a>`)
    })

    return {
        id: post.id,
        type: post.type,
        slug: post.slug,
        title: post.title,
        date: post.date,
        modifiedDate: post.modifiedDate,
        authors: post.authors,
        html: $("body").html() as string,
        footnotes: footnotes,
        excerpt: post.excerpt || $($("p")[0]).text(),
        imageUrl: post.imageUrl,
        tocHeadings: tocHeadings
    }
}

export async function formatPost(post: FullPost, grapherExports?: GrapherExports): Promise<FormattedPost> {
    let html = post.content

    // Standardize urls
    html = html.replace(new RegExp(WORDPRESS_URL, 'g'), BAKED_URL)
        .replace(new RegExp("https?://ourworldindata.org", 'g'), BAKED_URL)

    // If <!--raw--> appears at the top of a post, it signals that the author
    // wants to bypass the formatting and just write plain HTML
    const isRaw = html.match(/<!--raw-->/)

    if (isRaw) {
        return {
            id: post.id,
            type: post.type,
            slug: post.slug,
            title: post.title,
            date: post.date,
            modifiedDate: post.modifiedDate,
            authors: post.authors,
            html: html,
            footnotes: [],
            excerpt: post.excerpt||"",
            imageUrl: post.imageUrl,
            tocHeadings: []
        }
    } else {
        return formatWordpressPost(post, html, grapherExports)
    }
}

export function formatAuthors(authors: string[], requireMax?: boolean): string {
    if (requireMax && authors.indexOf("Max Roser") === -1)
        authors.push("Max Roser")

    let authorsText = authors.slice(0, -1).join(", ")
    if (authorsText.length == 0)
        authorsText = authors[0]
    else
        authorsText += ` and ${_.last(authors)}`
        
    return authorsText
}

export function formatDate(date: Date): string {
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' })
}