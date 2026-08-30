export const repository = 'https://github.com/xincheng213618/FanHao';
export const sections = [
  { title: '开始使用', pages: ['guide/quick-start', 'guide/development', 'guide/operations'] },
  { title: '理解系统', pages: ['architecture/overview', 'architecture/repository-map', 'architecture/modules', 'architecture/data-flow'] },
  { title: '与 AI 协作', pages: ['ai/context', 'ai/tasks', 'ai/safety'] },
  { title: '查阅契约', pages: ['reference/configuration', 'reference/api', 'reference/verification', 'reference/legacy'] },
  { title: '维护文档', pages: ['contributing/documentation', 'contributing/github-pages', 'decisions/0001-documentation'] }
];

export function deployment(env = process.env) {
  const base = env.DOCS_BASE || '/FanHao/';
  if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(base) || base.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('DOCS_BASE must be / or a safe path with leading/trailing slashes and no dot segments');
  }
  const origin = new URL(env.DOCS_ORIGIN || 'https://xincheng213618.github.io');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('DOCS_ORIGIN must contain only an HTTP(S) origin');
  }
  return { base, origin: origin.origin, url: `${origin.origin}${base}` };
}
