<script setup>
import { computed, ref, watch } from 'vue';
import { useData, withBase } from 'vitepress';
import { repository } from '../site.mjs';

const { page, frontmatter } = useData();
const feedback = ref('');
const reviewDate = computed(() => {
  const value = frontmatter.value.verified_at;
  return (value instanceof Date ? value.toISOString() : String(value ?? '')).slice(0, 10);
});
const markdownUrl = computed(() => withBase('/' + page.value.relativePath));
watch(markdownUrl, () => { feedback.value = ''; });
const sourceUrl = (source) => repository + '/tree/main/' + source.split('/').map(encodeURIComponent).join('/');
async function copyMarkdown() {
  feedback.value = '';
  try {
    const response = await fetch(markdownUrl.value);
    if (!response.ok) throw new Error('Markdown request failed');
    await navigator.clipboard.writeText(await response.text());
    feedback.value = '已复制 Markdown';
  } catch {
    feedback.value = '无法自动复制，请打开 Markdown 后复制';
  }
}
</script>

<template>
  <div class="doc-tools">
    <div class="doc-tools-top">
      <span class="verified-badge"><span aria-hidden="true">●</span> 维护中</span>
      <span class="review-date">源码核对 {{ reviewDate }}</span>
      <div class="doc-actions">
        <button type="button" @click="copyMarkdown">复制本页</button>
        <a :href="markdownUrl" target="_blank" rel="noopener">Markdown ↗</a>
      </div>
    </div>
    <details v-if="frontmatter.sources?.length" class="source-details">
      <summary>查看源码依据 · {{ frontmatter.sources.length }} 项</summary>
      <ul><li v-for="source in frontmatter.sources" :key="source"><a :href="sourceUrl(source)" target="_blank" rel="noopener">{{ source }}</a></li></ul>
      <p>核对日期表示人工对照源码的日期，不代表线上服务已经验收。</p>
    </details>
    <p v-if="feedback" class="copy-feedback" role="status">{{ feedback }}</p>
  </div>
</template>
