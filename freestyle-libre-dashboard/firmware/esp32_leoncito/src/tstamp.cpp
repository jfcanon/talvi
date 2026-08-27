#include "tstamp.h"
#include <stdio.h>

String lluFactoryToIso(const char* factory_ts) {
  if (!factory_ts) return "";
  int mo = 0, d = 0, y = 0, h = 0, mi = 0, s = 0;
  char ampm[3] = {0};
  int n = sscanf(factory_ts, "%d/%d/%d %d:%d:%d %2s", &mo, &d, &y, &h, &mi, &s, ampm);
  if (n != 7 || y < 2020 || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  if ((ampm[0] == 'P' || ampm[0] == 'p') && h != 12) h += 12;
  if ((ampm[0] == 'A' || ampm[0] == 'a') && h == 12) h = 0;
  if (h > 23 || mi > 59 || s > 59) return "";
  char buf[24];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ", y, mo, d, h, mi, s);
  return String(buf);
}
