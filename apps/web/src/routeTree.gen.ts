// Manually written route tree (not auto-generated)
import { Route as RootRoute } from './routes/__root.js';
import { Route as IndexRoute } from './routes/index.js';
import { Route as AccountsNewRoute } from './routes/accounts.new.js';
import { Route as AccountsIdRoute } from './routes/accounts.$id.js';
import { Route as AccountsIdBalanceRoute } from './routes/accounts.$id.balance.js';

// Build the route tree
// Note: AccountsIdBalanceRoute has getParentRoute: () => RootRoute and full path '/accounts/$id/balance'
// So it is added as a sibling to AccountsIdRoute at the root level
export const routeTree = RootRoute.addChildren([
  IndexRoute,
  AccountsNewRoute,
  AccountsIdRoute,
  AccountsIdBalanceRoute,
]);
