import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

import ScheduleSearch from './ScheduleSearch';

const ScheduleSearchDrawer = (props: ExtensionContextValue) => (
  <ScheduleSearch {...props} />
);

export default ScheduleSearchDrawer;
