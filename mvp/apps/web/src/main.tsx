import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { Center, Loader, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { AuditPage, SettingsPage } from './pages/AdminPages';
import { HomePage, Layout } from './pages/Layout';
import { LoginPage } from './pages/LoginPage';
import { MatrixPage } from './pages/MatrixPage';
import { DepartmentsPage, DictionariesPage, EnterprisesPage, ObjectsPage } from './pages/OrgPages';
import { TopicsPage } from './pages/TopicsPage';
import { UsersPage } from './pages/UsersPage';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function App() {
  const { me, loading } = useAuth();
  if (loading)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  if (!me) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="enterprises" element={<EnterprisesPage />} />
        <Route path="departments" element={<DepartmentsPage />} />
        <Route path="topics" element={<TopicsPage />} />
        <Route path="objects" element={<ObjectsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="matrix" element={<MatrixPage />} />
        <Route path="dictionaries" element={<DictionariesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<HomePage />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider>
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
