// CoreWLAN WiFi scanner for macOS.
//
// The app deliberately does NOT request Location Services. Without location
// authorization, CWNetwork returns nil for ssid/ssidData/bssid on modern
// macOS, so the scan below simply yields no named networks there and the
// WiFi setup flow falls back to manual connection. No permission dialog is
// ever triggered.

#import <CoreWLAN/CoreWLAN.h>
#import <Foundation/Foundation.h>

// ---------------------------------------------------------------------------
// WiFi scan
// ---------------------------------------------------------------------------

static __thread char *_scan_buf = NULL;

/// Scan nearby WiFi networks via CoreWLAN.
///
/// Returns a JSON C-string: `[{"ssid":"...","rssi":-50}, ...]`
/// Returns NULL on error. Caller must NOT free the result.
const char *corewlan_scan_networks(void) {
    @autoreleasepool {
        CWWiFiClient *client = [CWWiFiClient sharedWiFiClient];
        if (!client) return NULL;

        CWInterface *iface = [client interface];
        if (!iface) return NULL;

        NSError *error = nil;
        NSSet<CWNetwork *> *networks = [iface scanForNetworksWithName:nil
                                                                error:&error];
        if (error) {
            NSLog(@"[wifi] CoreWLAN scan error: %@", error.localizedDescription);
            return NULL;
        }
        if (!networks) return NULL;

        NSMutableArray *results = [NSMutableArray arrayWithCapacity:networks.count];
        NSMutableSet *seen = [NSMutableSet set];

        for (CWNetwork *net in networks) {
            NSString *ssid = net.ssid;
            if (!ssid && net.ssidData) {
                ssid = [[NSString alloc] initWithData:net.ssidData
                                             encoding:NSUTF8StringEncoding];
            }
            if (!ssid || ssid.length == 0 || [seen containsObject:ssid]) continue;
            [seen addObject:ssid];

            [results addObject:@{
                @"ssid": ssid,
                @"rssi": @(net.rssiValue)
            }];
        }

        NSData *json = [NSJSONSerialization dataWithJSONObject:results
                                                       options:0
                                                         error:nil];
        if (!json) return NULL;

        NSString *jsonStr = [[NSString alloc] initWithData:json
                                                  encoding:NSUTF8StringEncoding];
        free(_scan_buf);
        _scan_buf = strdup([jsonStr UTF8String]);
        return _scan_buf;
    }
}
