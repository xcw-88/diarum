import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
	plugins: [
		sveltekit(),
		SvelteKitPWA({
			srcDir: './src',
			mode: 'production',
			strategies: 'generateSW',
			scope: '/',
			base: '/',
			selfDestroying: false,
			manifest: {
				name: 'Diarum - Personal Diary',
				short_name: 'Diarum',
				description: 'A simple, elegant, and self-hosted diary application with AI-powered insights.',
				theme_color: '#ffffff',
				background_color: '#ffffff',
				display: 'standalone',
				scope: '/',
				start_url: '/',
				orientation: 'portrait-primary',
				icons: [
					{
						src: '/android-chrome-192x192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'any'
					},
					{
						src: '/android-chrome-192x192.png',
						sizes: '192x192',
						type: 'image/png',
						purpose: 'maskable'
					},
					{
						src: '/android-chrome-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any'
					},
					{
						src: '/android-chrome-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				],
				screenshots: [
					{
						src: '/screenshots/mobile-light.png',
						sizes: '930x1734',
						type: 'image/png',
						form_factor: 'narrow',
						label: 'Mobile view - Light theme'
					},
					{
						src: '/screenshots/mobile-dark.png',
						sizes: '924x1734',
						type: 'image/png',
						form_factor: 'narrow',
						label: 'Mobile view - Dark theme'
					},
					{
						src: '/screenshots/desktop-light.png',
						sizes: '2522x2012',
						type: 'image/png',
						form_factor: 'wide',
						label: 'Desktop view - Light theme'
					},
					{
						src: '/screenshots/desktop-dark.png',
						sizes: '2544x2018',
						type: 'image/png',
						form_factor: 'wide',
						label: 'Desktop view - Dark theme'
					}
				]
			},
			injectManifest: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}']
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
				cleanupOutdatedCaches: true,
				skipWaiting: true,
				clientsClaim: true,
				runtimeCaching: [
					{
						urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'google-fonts-cache',
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 365 days
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					{
						urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
						handler: 'CacheFirst',
						options: {
							cacheName: 'gstatic-fonts-cache',
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 365 days
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					{
						urlPattern: ({ url }) =>
							url.origin === self.location.origin && url.pathname.startsWith('/api/v1/files/media/'),
						handler: 'NetworkOnly',
						options: {
							fetchOptions: { cache: 'no-store' }
						}
					},
					{
						// Every work memo is owner-specific private data - it carries
						// its owner, its `date` and its full body, and
						// `/by-date/<date>` answers "what did this user write that
						// day". None of it may be written to Cache Storage: a cache
						// entry is keyed by URL and does not vary with the Bearer
						// token, so the generic `api-cache` below (NetworkFirst, 7-day
						// expiration) could hand one account the previous account's
						// memos for the same URL while offline or after a
						// NetworkFirst timeout.
						//
						// The rule covers the whole `/api/v1/work-memos` subtree -
						// `/by-date/:date`, `/calendar`, `/:id`, `/:id/media` and
						// `/search` - so a newly added read cannot miss the boundary.
						// It is declared *before* the generic `/api/` rule on
						// purpose: Workbox uses first-match semantics, so a later
						// rule can never override an earlier one. `cache: 'no-store'`
						// keeps the browser HTTP cache out of the picture too, and the
						// backend sends `Cache-Control: private, no-store` +
						// `Vary: Authorization` as well, so the boundary holds even if
						// this rule is dropped.
						urlPattern: /\/api\/v1\/work-memos(\/|\?|$)/i,
						handler: 'NetworkOnly',
						options: {
							fetchOptions: { cache: 'no-store' }
						}
					},
					{
						urlPattern: /\/api\/.*/i,
						handler: 'NetworkFirst',
						options: {
							cacheName: 'api-cache',
							networkTimeoutSeconds: 10,
							expiration: {
								maxEntries: 50,
								maxAgeSeconds: 60 * 60 * 24 * 7 // 7 days
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					}
				]
			},
			devOptions: {
				enabled: false,
				suppressWarnings: true,
				type: 'module'
			}
		})
	],
	server: {
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://localhost:8090',
				changeOrigin: true
			},
			'/_': {
				target: 'http://localhost:8090',
				changeOrigin: true
			}
		}
	}
});
