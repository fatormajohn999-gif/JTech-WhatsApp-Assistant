import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.jtech.assistant',
  appName: 'JTech Assistant',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  }
};

export default config;
