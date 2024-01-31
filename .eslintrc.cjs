module.exports = {
	root: true,
	extends: ['@hokify'],
	parserOptions: {
		project: './tsconfig.eslint.json'
	},
  overrides: [
    {
      files: ['*ts'],
      rules: {
        '@typescript-eslint/ban-ts-comment': 'off',
      },
    },
    {
      files: ['*.test.ts'],
      env: {
        mocha: true
      },
      rules: {
        '@typescript-eslint/no-unused-expressions': 'off',
        'import/no-relative-packages': 'off'
      }
    }
  ]
};
