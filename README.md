# VectorSeek AI Search

Contributors: vectorseek

Tags: private AI search, AI search, site search, semantic search

License: GPLv3 or later

License URI: https://www.gnu.org/licenses/gpl-3.0.html

VectorSeek brings powerful private AI search to your site. Index your
content and provide fast, intelligent answers to users.


## Description

**VectorSeek AI Search** transforms your website into an intelligent, private-search experience powered by your own content. Built for businesses, media publishers, and knowledge-rich websites, VectorSeek helps your visitors and team find answers instantly — with zero training leakage.

🔐 **Privacy-First**
Choose to use our private LLMs or connect to public models. VectorSeek runs indexing and AI querying through private, secure infrastructure.

⚡ **Blazing Fast Answers**
Built on vector embeddings and retrieval-augmented generation (RAG), VectorSeek delivers high-quality answers from your actual site data.

🧠 **Smart Content Indexing**
Automatically pulls and indexes your pages, posts, PDFs, and other content types.

💬 **Customizable Search Embedding**
Choose to include VectorSeek in your search results page, or add a VectorSeek query box with a simple shortcode.

## Features

- Private vector-based AI search
- Semantic understanding of your content
- Embedded AI Search
- No data sent to OpenAI or public APIs (unless selected)

## Installation

1. Create an account on [VectorSeek](https://vectorseek.ai)
2. Add the following code on your site.

```html
<div id="app"></div>
<input type="hidden" id="vectorseek_key" value="<Your Token>"/>
<script type="module" src="https://cdn.jsdelivr.net/gh/stw/vectorseek-ai-js@main/src/main.js"></script>
```


## Frequently Asked Questions

### How does this work?
VectorSeek indexes your site content and hosts a private vector database. When users ask questions, it retrieves and summarizes the most relevant answers from your indexed content using hosted LLMs or public LLMs if you choose. 

### Is my data safe?
Yes. All processing occurs through secure, private infrastructure. Your content
is not used to train public AI models (unless you choose a public model).
Multiple private and public Providers and Models are available in your
VectorSeek account and you have the ability to choose from any model available. 

### Can I control which content is indexed?
Yes — you can include or exclude specific post types, categories, or pages in the plugin settings.

### Does it work with PDFs or custom post types?
Absolutely. PDFs, pages, blog posts, and most custom post types are supported.

### Can I crawl sub-domains?
Yes, you can crawl multiple domains and sub-domains as part of a single project. All crawled content will be used to generate answers. 

### Can I use sitemap.xml?
Yes, you can add your url with sitemap as one of the urls, ex. https://vectorseek.ai/sitemap.xml

## Screenshots

1. Plugin settings and content indexing options
2. VectorSeek account settings
3. Example of AI-generated answers from site content

## Changelog

### 0.0.1
* Initial release: private AI search with semantic indexing and chatbot widget

## Upgrade Notice

### 0.0.1
First stable release — secure AI search for your content.

