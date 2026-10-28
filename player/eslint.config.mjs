import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'

// ESLint 9 flat config. Type-aware rules are intentionally disabled until the
// project-wide vue-tsc backlog (documented in docs/AUDIT_REMEDIATION.md) is clean.
export default defineConfigWithVueTs(
  {
    name: 'sonic/ignores',
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'build/**', 'coverage/**', 'src/auto-import/**'],
  },
  {
    name: 'sonic/files',
    files: ['src/**/*.{js,mjs,ts,vue}', 'scripts/**/*.{js,mjs}'],
  },
  pluginVue.configs['flat/essential'],
  vueTsConfigs.base,
  vueTsConfigs.disableTypeChecked,
  skipFormatting,
  {
    name: 'sonic/rules',
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-empty': 'off',
      'no-undef': 'off',
    },
  },
)
