import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

import ScheduleSearch from './ScheduleSearch';

// The default viewport has no objectContext, including on schedule pages.
const ScheduleSearchDrawer = (props: ExtensionContextValue) => (
  <ScheduleSearch {...props} />
);

export default ScheduleSearchDrawer;
