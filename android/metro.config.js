// Lets the app import the shared, pure-TS sync core from ../src/shared/sync
// (one implementation for Mac + Android). Everything else resolves from
// android/node_modules as before.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const shared = path.resolve(__dirname, '../src/shared/sync');
config.watchFolders = [...(config.watchFolders ?? []), shared];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
