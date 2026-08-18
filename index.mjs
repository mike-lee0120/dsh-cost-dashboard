/**
 * dsh-cost-dashboard host entry: mounts the dashboard HTTP routes once the
 * profile composes the webServer service.
 */
import { mountRoutes } from './routes.mjs';
import { zstdSupported } from './scan.mjs';

export const name = 'cost-dashboard';
export const using = [];

export function apply(ctx) {
	if (!zstdSupported) {
		ctx.logger?.warn?.('dsh-cost-dashboard: node:zlib zstd API unavailable on this Node build - routes will answer 503');
	}
	ctx.inject(['webServer'], (host) => {
		host.effect(() => mountRoutes(host), 'cost-dashboard: routes');
	});
}
