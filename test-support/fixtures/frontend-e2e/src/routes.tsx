import { Routes, Route } from 'react-router-dom';
import { Orders } from './App';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/orders/:id" element={<Orders />} />
    </Routes>
  );
}
