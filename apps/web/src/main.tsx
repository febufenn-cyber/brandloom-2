import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Root from './Root';
import './styles.css';
import './operations.css';
import './publishing.css';
import './commercial.css';
import './optimization.css';
import './reliability.css';
import './activation.css';
import './beta.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
