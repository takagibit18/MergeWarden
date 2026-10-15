import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import ConfigProvider from 'antd/es/config-provider';
import theme from 'antd/es/theme';
import zhCN from 'antd/locale/zh_CN';

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const subscribeColorScheme = (listener: () => void) => {
  colorScheme.addEventListener('change', listener);
  return () => colorScheme.removeEventListener('change', listener);
};
const getColorScheme = () => colorScheme.matches;

export function WorkbenchTheme({ children }: { children: ReactNode }) {
  const dark = useSyncExternalStore(subscribeColorScheme, getColorScheme, () => false);

  return (
    <ConfigProvider locale={zhCN} theme={{
      algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorPrimary: dark ? '#ededed' : '#181818',
        colorInfo: dark ? '#afafaf' : '#5d5d5d',
        colorText: dark ? '#dcdcdc' : '#282828',
        colorTextSecondary: dark ? '#afafaf' : '#5d5d5d',
        colorTextTertiary: '#8f8f8f',
        colorBorder: dark ? '#3c3c3c' : '#e5e5e5',
        colorBorderSecondary: dark ? '#303030' : '#ededed',
        colorBgContainer: dark ? '#212121' : '#ffffff',
        colorBgElevated: dark ? '#303030' : '#ffffff',
        colorBgLayout: dark ? '#212121' : '#ffffff',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: 14,
        fontSizeSM: 12,
        borderRadius: 8,
        controlHeight: 32,
        controlOutlineWidth: 2,
      },
      components: {
        Button: {
          primaryColor: dark ? '#181818' : '#ffffff',
          primaryShadow: 'none',
          defaultShadow: 'none',
          fontWeight: 500,
          paddingInline: 12,
        },
        Select: {
          optionSelectedBg: dark ? '#414141' : '#ededed',
          optionSelectedColor: dark ? '#ededed' : '#181818',
          optionActiveBg: dark ? '#383838' : '#f3f3f3',
        },
        Tag: { defaultBg: dark ? '#303030' : '#f3f3f3', defaultColor: dark ? '#afafaf' : '#5d5d5d' },
        Drawer: { colorBgElevated: dark ? '#181818' : '#f9f9f9' },
      },
    }}>{children}</ConfigProvider>
  );
}
