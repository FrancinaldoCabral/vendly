/**
 * theme.ts — Identidade visual "Redatudo" aplicada ao dashboard Vendly.
 * Fundo navy escuro, gradiente roxo→azul, accent roxo, fontes Outfit (títulos) + Inter (corpo).
 * Centraliza a paleta para que Login, Layout e o ConfigProvider do Ant fiquem coerentes.
 */
export const brand = {
  // Superfícies escuras (sidebar, login, áreas de marca)
  bgDark: '#0F0F1A',
  surface: '#161622',
  cardGradient: 'linear-gradient(145deg, #1F2937 0%, #111827 100%)',
  border: '#374151',

  // Acentos
  primary: '#7C3AED',      // roxo principal (colorPrimary do Ant)
  primaryHover: '#8B5CF6',
  purpleLight: '#A78BFA',
  blue: '#3B82F6',
  blueLight: '#60A5FA',
  green: '#10B981',

  // Gradiente da marca (texto/logo)
  gradient: 'linear-gradient(135deg, #A78BFA 0%, #60A5FA 100%)',
  gradientGreen: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',

  // Tipografia
  fontHeading: "'Outfit', 'Segoe UI', sans-serif",
  fontBody: "'Inter', 'Segoe UI', sans-serif",
};

/** Estilo inline para aplicar o gradiente da marca em texto (logo, títulos). */
export const gradientText: React.CSSProperties = {
  background: brand.gradient,
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
};
