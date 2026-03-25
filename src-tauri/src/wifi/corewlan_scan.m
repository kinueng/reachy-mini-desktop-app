// CoreWLAN WiFi scanner + Location permission helper for macOS.
//
// Location Services must be granted for SSID/BSSID to be visible in CoreWLAN.
// Without it, CWNetwork returns nil for ssid, ssidData, and bssid.
//
// All CLLocationManager access is serialized on the main queue to avoid
// thread-safety issues (the manager and delegate are stored in statics).

#import <CoreWLAN/CoreWLAN.h>
#import <CoreLocation/CoreLocation.h>
#import <Foundation/Foundation.h>

// ---------------------------------------------------------------------------
// Location permission
// ---------------------------------------------------------------------------

@interface _WifiLocationDelegate : NSObject <CLLocationManagerDelegate>
@end

@implementation _WifiLocationDelegate
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
    CLAuthorizationStatus status = [manager authorizationStatus];
    NSLog(@"[wifi] Location authorization changed: %d", (int)status);
}
@end

// Persistent manager + delegate (must outlive the request).
// Only accessed from the main queue (via ensure_manager / dispatch blocks).
static CLLocationManager *_locationManager = nil;
static _WifiLocationDelegate *_locationDelegate = nil;

/// Ensure the CLLocationManager exists (call from main queue only).
static void ensure_manager(void) {
    if (!_locationManager) {
        _locationManager = [[CLLocationManager alloc] init];
        _locationDelegate = [[_WifiLocationDelegate alloc] init];
        _locationManager.delegate = _locationDelegate;
    }
}

/// Check current location authorization status (thread-safe).
/// Dispatches to the main queue to access CLLocationManager.
/// Returns CLAuthorizationStatus as int.
int corewlan_location_status(void) {
    __block int status = 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        ensure_manager();
        status = (int)[_locationManager authorizationStatus];
        dispatch_semaphore_signal(sem);
    });

    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC));
    return status;
}

/// Request location permission from any thread.
/// Dispatches to the main queue so CLLocationManager shows the dialog.
/// Returns the current CLAuthorizationStatus (may still be 0 if dialog is pending).
int corewlan_request_location(void) {
    __block int status = 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    dispatch_async(dispatch_get_main_queue(), ^{
        ensure_manager();
        status = (int)[_locationManager authorizationStatus];
        if (status == kCLAuthorizationStatusNotDetermined) {
            NSLog(@"[wifi] Requesting location permission (dispatched to main queue)...");
            [_locationManager requestWhenInUseAuthorization];
        }
        dispatch_semaphore_signal(sem);
    });

    // Wait up to 1s for the main-queue block to execute
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC));
    return status;
}

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
