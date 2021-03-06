import * as wpdb from "./wpdb"
import {ArticlePage} from './views/ArticlePage'
import {BlogPostPage} from './views/BlogPostPage'
import {BlogIndexPage} from './views/BlogIndexPage'
import {FrontPage} from './views/FrontPage'
import SubscribePage from './views/SubscribePage'
import * as React from 'react'
import * as ReactDOMServer from 'react-dom/server'
import * as url from 'url'
import * as path from 'path'
import * as glob from 'glob'
import * as _ from 'lodash'
import * as fs from 'fs-extra'
import { WORDPRESS_DIR } from './settings'
import { formatPost } from './formatting'
import { bakeGrapherUrls, getGrapherExportsByUrl } from "./grapherUtil";
import * as cheerio from 'cheerio'

// Wrap ReactDOMServer to stick the doctype on
export function renderToHtmlPage(element: any) {
    return `<!doctype html>${ReactDOMServer.renderToStaticMarkup(element)}`
}

export async function renderPageById(id: number, isPreview?: boolean): Promise<string> {
    let rows
    if (isPreview) {
        rows = await wpdb.query(`SELECT post.*, parent.post_type FROM wp_posts AS post JOIN wp_posts AS parent ON parent.ID=post.post_parent WHERE post.post_parent=? AND post.post_type='revision' ORDER BY post_modified DESC`, [id])
    } else {
        rows = await wpdb.query(`SELECT * FROM wp_posts AS post WHERE ID=?`, [id])
    }

    const post = await wpdb.getFullPost(rows[0])
    const entries = await wpdb.getEntriesByCategory()

    const $ = cheerio.load(post.content)
    const grapherUrls = $("iframe").toArray().filter(el => (el.attribs['src']||'').match(/\/grapher\//)).map(el => el.attribs['src'])
    await bakeGrapherUrls(grapherUrls, { silent: true })

    const exportsByUrl = await getGrapherExportsByUrl()
    const formatted = await formatPost(post, exportsByUrl)

    if (rows[0].post_type === 'post')
        return renderToHtmlPage(<BlogPostPage entries={entries} post={formatted}/>)
    else
        return renderToHtmlPage(<ArticlePage entries={entries} post={formatted}/>)
}

export async function renderFrontPage() {
    const postRows = await wpdb.query(`
        SELECT ID, post_title, post_date, post_name FROM wp_posts
        WHERE post_status='publish' AND post_type='post' ORDER BY post_date DESC LIMIT 6`)
    
    const permalinks = await wpdb.getPermalinks()

    const posts = postRows.map(row => {
        return {
            title: row.post_title,
            date: new Date(row.post_date),
            slug: permalinks.get(row.ID, row.post_name)            
        }
    })

    const entries = await wpdb.getEntriesByCategory()

    return renderToHtmlPage(<FrontPage entries={entries} posts={posts}/>)
}

export async function renderSubscribePage() {
    return renderToHtmlPage(<SubscribePage/>)
}

export async function renderBlogByPageNum(pageNum: number) {
    const postsPerPage = 21

    const allPosts = await wpdb.getBlogIndex()

    const numPages = Math.ceil(allPosts.length/postsPerPage)
    const posts = allPosts.slice((pageNum-1)*postsPerPage, pageNum*postsPerPage)
    
    for (const post of posts) {
        if (post.imageUrl) {
            // Find a smaller version of this image
            try {
                const pathname = url.parse(post.imageUrl).pathname as string
                const paths = glob.sync(path.join(WORDPRESS_DIR, pathname.replace(/.png/, "*.png")))
                const sortedPaths = _.sortBy(paths, path => fs.statSync(path).size)
                post.imageUrl = sortedPaths[sortedPaths.length-3].replace(WORDPRESS_DIR, '')    
            } catch (err) {
                console.error(err)
                // Just use the big one
            }
        }
    }

    const entries = await wpdb.getEntriesByCategory()
    return renderToHtmlPage(<BlogIndexPage entries={entries} posts={posts} pageNum={pageNum} numPages={numPages}/>)
}

async function main(target: string, isPreview?: boolean) {
    try {
        if (target === 'front') {
            console.log(await renderFrontPage())
        } else if (target === 'subscribe') {
            console.log(await renderSubscribePage())
        } else if (target == "blog") {
            const pageNum = process.argv[3] ? parseInt(process.argv[3]) : 1
            console.log(await renderBlogByPageNum(pageNum === 0 ? 1 : pageNum))            
        } else {
            console.log(await renderPageById(parseInt(target), isPreview))
        }
    } catch (err) {
        console.error(err)
    } finally {
        wpdb.end()
    }
}

if (require.main == module)
    main(process.argv[2], process.argv[3] === "preview")
