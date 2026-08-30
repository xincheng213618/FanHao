import { defineConfig } from 'vitepress';
import { sections, repository, deployment } from './site.mjs';
import { readPage, generatedRoot, sha256 } from './scripts/content.mjs';
import { devGenerationPlugin } from './scripts/dev-generation.mjs';

const site = deployment();
export default defineConfig({
  lang: 'zh-CN',
  title: 'FanHao',
  description: '面向开发者与 AI 协作者的本地媒体资料库文档。',
  base: site.base,
  srcDir: './site',
  srcExclude: ['public/**', '**/AGENTS.md'],
  cleanUrls: false,
  ignoreDeadLinks: false,
  lastUpdated: true,
  sitemap: { hostname: site.url },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: site.base + 'favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#087f70' }]
  ],
  transformHead({ pageData }) {
    if (pageData.relativePath === '404.md') return [];
    return [
      ['meta', { name: 'fanhao:source-sha256', content: sha256(readPage(pageData.relativePath.replace(/\.md$/, '')).raw) }],
      ['link', { rel: 'alternate', type: 'text/markdown', href: site.base + pageData.relativePath }],
      ['link', { rel: 'describedby', type: 'text/plain', href: site.base + 'llms.txt' }]
    ];
  },
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'FanHao / Docs',
    nav: [
      { text: '开始使用', link: '/guide/quick-start' },
      { text: '架构', link: '/architecture/overview' },
      { text: 'AI 协作', link: '/ai/context' },
      { text: '维护规范', link: '/contributing/documentation' }
    ],
    sidebar: sections.map((section) => ({ text: section.title, collapsed: false, items: section.pages.map((id) => ({ text: readPage(id).meta.title, link: '/' + id })) })),
    socialLinks: [{ icon: 'github', link: repository }],
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            tokenize: (text) => [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)].filter((segment) => segment.isWordLike).map((segment) => segment.segment)
          },
          searchOptions: { prefix: true, fuzzy: 0.2 }
        },
        locales: { root: { translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' }, modal: { displayDetails: '显示详情', resetButtonTitle: '清除搜索', backButtonTitle: '关闭搜索', noResultsText: '没有找到相关内容', footer: { selectText: '选择', selectKeyAriaLabel: '回车', navigateText: '切换', navigateUpKeyAriaLabel: '向上', navigateDownKeyAriaLabel: '向下', closeText: '关闭', closeKeyAriaLabel: '退出' } } } } }
      }
    },
    editLink: { pattern: repository + '/edit/main/docs/site/:path', text: '在 GitHub 编辑此页' },
    outline: { level: [2, 3], label: '本页内容' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '文档最后提交' },
    sidebarMenuLabel: '目录',
    returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换浅色主题',
    darkModeSwitchTitle: '切换深色主题',
    notFound: { title: '页面未找到', quote: '从目录或搜索重新找到需要的项目知识。', linkLabel: '返回首页', linkText: '返回文档首页' },
    footer: { message: '源码可追溯 · Markdown 可直读 · 本地优先', copyright: 'FanHao 项目文档' }
  },
  markdown: { lineNumbers: true, theme: { light: 'github-light', dark: 'github-dark' } },
  vite: {
    plugins: [devGenerationPlugin()],
    publicDir: generatedRoot,
    server: { host: '127.0.0.1' },
    preview: { host: '127.0.0.1' }
  }
});
