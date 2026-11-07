import { defineConfig } from "vite-plus";

const sandboxed = {
	globalSetup: ["test/support/global-sandbox.ts"],
	setupFiles: ["test/support/worker-sandbox.ts"],
};

export default defineConfig({
	fmt: {
		useTabs: true,
		printWidth: 120,
		sortPackageJson: false,
		ignorePatterns: ["CHANGELOG.md", "**/__snapshots__/**"],
	},
	lint: {
		options: {
			typeAware: true,
			typeCheck: true,
		},
		rules: {
			"typescript/no-floating-promises": "error",
			"typescript/no-misused-promises": "error",
			"typescript/await-thenable": "error",
			"typescript/no-explicit-any": "error",
			"no-console": "error",
		},
	},
	test: {
		projects: [
			{ extends: true, test: { name: "unit", include: ["src/**/*.test.ts"], ...sandboxed } },
			{
				extends: true,
				test: { name: "integration", include: ["test/integration/**/*.test.ts"], testTimeout: 30_000, ...sandboxed },
			},
			{
				extends: true,
				test: { name: "process", include: ["test/process/**/*.test.ts"], testTimeout: 60_000, ...sandboxed },
			},
			{ extends: true, test: { name: "e2e", include: ["test/e2e/**/*.test.ts"], testTimeout: 600_000 } },
		],
	},
});
