import { getLocation, LOCATION_SLUGS } from '@otrip/world';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { LocationScene } from '@/components/scene/location-scene';

type LocationPageProps = {
  params: Promise<{ location: string }>;
};

export const generateStaticParams = async () => LOCATION_SLUGS.map((location) => ({ location }));

export const generateMetadata = async ({ params }: LocationPageProps): Promise<Metadata> => {
  const recipe = getLocation((await params).location);
  if (!recipe) return {};

  return {
    title: `${recipe.name}, ${recipe.region}`,
    description: recipe.description,
  };
};

export default async function LocationPage({ params }: LocationPageProps) {
  const recipe = getLocation((await params).location);
  if (!recipe) notFound();

  return (
    <main>
      <LocationScene recipe={recipe} />
    </main>
  );
}
