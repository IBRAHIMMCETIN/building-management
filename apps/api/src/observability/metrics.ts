/**
 * CloudWatch Embedded Metric Format (EMF): metrik, yapilandirilmis log satiri olarak yazilir ve
 * CloudWatch Logs tarafindan metrige donusturulur. `cloudwatch:PutMetricData` yetkisi ve ek
 * SDK cagrisi gerekmez; Lambda'nin log izni yeterlidir.
 *
 * Boyut yalnizca `Stack` (ortam/yigin adi): alarmlar sabit boyutla calisir, apartman bazli
 * boyut kardinaliteyi (ve maliyeti) buyutur. Apartman ayrintisi ayni log satirinin
 * ozelliklerinde (metrik olmayan alanlar) tasinir.
 */

export const METRICS_NAMESPACE = 'BuildingManagement';

export type MetricUnit = 'Count' | 'Seconds' | 'Milliseconds' | 'None';

export type MetricsEmitter = {
  emit(metrics: Record<string, number>, properties?: Record<string, unknown>, unit?: MetricUnit): void;
};

export function createEmfEmitter(options: {
  stack: string;
  namespace?: string;
  log?: Pick<Console, 'log'>;
  now?: () => Date;
}): MetricsEmitter {
  const log = options.log ?? console;
  const now = options.now ?? (() => new Date());
  return {
    emit(metrics, properties = {}, unit = 'Count') {
      const names = Object.keys(metrics);
      if (names.length === 0) return;
      log.log(
        JSON.stringify({
          ...properties,
          _aws: {
            Timestamp: now().getTime(),
            CloudWatchMetrics: [
              {
                Namespace: options.namespace ?? METRICS_NAMESPACE,
                Dimensions: [['Stack']],
                Metrics: names.map((Name) => ({ Name, Unit: unit })),
              },
            ],
          },
          Stack: options.stack,
          ...metrics,
        }),
      );
    },
  };
}

/** Ortam: `METRICS_STACK` (Terraform: yigin adi); yerelde `local`. */
export function createEmfEmitterFromEnv(env: NodeJS.ProcessEnv = process.env): MetricsEmitter {
  return createEmfEmitter({ stack: env.METRICS_STACK ?? 'local' });
}

/** Metrik yayinlamayan yayinci (yerel gelistirme ve testler). */
export const noopMetrics: MetricsEmitter = { emit: () => {} };
