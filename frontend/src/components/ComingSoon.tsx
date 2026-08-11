import { Card, CardContent } from '@/components/ui/card';

export function ComingSoon({ title }: { title: string }) {
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">{title}</h1>
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {title} isn't built yet — coming soon.
        </CardContent>
      </Card>
    </div>
  );
}
