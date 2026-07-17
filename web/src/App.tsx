import { HashRouter, Routes, Route } from "react-router-dom";
import LibraryPage from "./pages/LibraryPage";
import BookPage from "./pages/BookPage";

// HashRouter (not BrowserRouter): the app is hosted statically on GitHub Pages
// under a project subpath, so hash routing keeps deep links working without a
// server-side rewrite/404 fallback.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<LibraryPage />} />
        <Route path="/book/:slug" element={<BookPage />} />
        <Route path="*" element={<LibraryPage />} />
      </Routes>
    </HashRouter>
  );
}
