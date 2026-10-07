import { registerRootComponent } from 'expo';
import App from './App';

// Native entry point: registers the root component as "main", which is what
// MainActivity (getMainComponentName) loads. Without this call the release
// bundle evaluates but registers nothing and the app dies on open with
// 'Invariant Violation: "main" has not been registered'.
registerRootComponent(App);
