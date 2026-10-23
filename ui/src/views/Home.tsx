import { Box, ContextView, Link } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

import BrandIcon from './brand_icon.svg';
import { GM_FINANCIAL_BLUE } from './branding';
import { getDashboardUrl } from './scheduleSearchData';

const Home = ({ environment, userContext }: ExtensionContextValue) => (
  <ContextView title="" brandColor={GM_FINANCIAL_BLUE} brandIcon={BrandIcon}>
    <Box css={{ stack: 'y', rowGap: 'medium' }}>
      <Box
        css={{
          borderColor: 'neutral',
          borderRadius: 'medium',
          borderStyle: 'solid',
          borderWidth: 1,
          padding: 'medium',
          rowGap: 'small',
          stack: 'y',
        }}
      >
        <Link
          href={getDashboardUrl(
            { accountId: userContext.account.id, mode: environment.mode },
            '/subscriptions'
          )}
        >
          Subscription Schedule Search
        </Link>
        <Box>Find subscription schedules by account number or confirmation number.</Box>
      </Box>
    </Box>
  </ContextView>
);

export default Home;
