import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import DocTools from './DocTools.vue';
import HomeMap from './HomeMap.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'doc-before': () => h(DocTools),
      'home-hero-image': () => h(HomeMap)
    });
  }
};
