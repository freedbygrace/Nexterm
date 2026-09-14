/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

#include "config.h"

#include "display.h"
#include "input.h"
#include "spice.h"

#include <guacamole/client.h>
#include <guacamole/display.h>
#include <guacamole/protocol.h>
#include <guacamole/protocol-constants.h>
#include <guacamole/rect.h>
#include <guacamole/socket.h>
#include <spice-client.h>

#include <pthread.h>
#include <stdio.h>
#include <string.h>

/**
 * Appends a single monitor entry to the "multimon-layout" JSON object being
 * built in the given buffer, e.g. {@code "0":{"left":0,"top":0,"width":1024,
 * "height":768}}. Every value is an integer, so no escaping is required.
 *
 * @param json
 *     The buffer holding the JSON object under construction.
 *
 * @param pos
 *     The current write offset within json (the index of the next free byte).
 *
 * @param size
 *     The total size of json, in bytes.
 *
 * @param written
 *     The number of entries already appended, used to decide whether a leading
 *     comma separator is required.
 *
 * @param index
 *     The monitor index to use as the JSON key.
 *
 * @param left
 * @param top
 * @param width
 * @param height
 *     The position and size of the monitor within the combined framebuffer.
 *
 * @return
 *     The new write offset within json, or a negative value if the entry would
 *     not fit (in which case json is left unmodified past pos).
 */
static int guac_spice_layout_append(char* json, int pos, int size,
        int written, int index, int left, int top, int width, int height) {

    int remaining = size - pos;
    int length = snprintf(json + pos, remaining,
            "%s\"%d\":{\"left\":%d,\"top\":%d,\"width\":%d,\"height\":%d}",
            (written ? "," : ""), index, left, top, width, height);

    if (length < 0 || length >= remaining)
        return -1;

    return pos + length;

}

/**
 * Returns the SPICE channel id of the given channel, as reported by its
 * "channel-id" GObject property. A SPICE session opens one display channel per
 * guest QXL device, each with a distinct, contiguous, zero-based id.
 */
static int guac_spice_display_channel_id(SpiceChannel* channel) {
    gint id = 0;
    g_object_get(channel, "channel-id", &id, NULL);
    return (int) id;
}

/**
 * Returns the per-channel display state slot for the given SPICE display
 * channel, or NULL if the channel's id falls outside the supported range
 * (GUAC_SPICE_MAX_MONITORS).
 */
static guac_spice_display_state* guac_spice_display_slot(
        guac_spice_client* spice_client, SpiceChannel* channel) {

    int id = guac_spice_display_channel_id(channel);
    if (id < 0 || id >= GUAC_SPICE_MAX_MONITORS)
        return NULL;

    return &spice_client->displays[id];

}

/**
 * Composites a region of one display channel's primary surface into that
 * channel's assigned position within the combined Guacamole default layer. The
 * source region is given in the channel's own surface coordinates; it is
 * clamped to the surface, translated by the channel's origin, and clamped again
 * to the layer bounds before copying. Must be called with surface_lock held and
 * the given raw context open.
 *
 * @param context
 *     The open raw drawing context for the default layer.
 *
 * @param display
 *     The display channel state whose surface should be composited.
 *
 * @param rx
 * @param ry
 * @param rw
 * @param rh
 *     The damaged region within the channel's surface, in surface pixels.
 *
 * @param swap_red_blue
 *     Non-zero if the red and blue channels should be swapped per-pixel (for
 *     the rare server which reports BGR instead of RGB).
 */
static void guac_spice_composite_region(guac_display_layer_raw_context* context,
        const guac_spice_display_state* display, int rx, int ry, int rw, int rh,
        int swap_red_blue) {

    const unsigned char* surface = (const unsigned char*) display->data;
    if (surface == NULL)
        return;

    /* Clamp the requested region to this channel's surface */
    guac_rect src;
    guac_rect_init(&src, rx, ry, rw, rh);

    guac_rect surface_bounds;
    guac_rect_init(&surface_bounds, 0, 0, display->width, display->height);
    guac_rect_constrain(&src, &surface_bounds);

    if (guac_rect_width(&src) <= 0 || guac_rect_height(&src) <= 0)
        return;

    /* Translate the (clamped) source region to its destination within the
     * combined layer, then clamp to the current pending frame */
    guac_rect dst;
    guac_rect_init(&dst, display->origin_x + src.left,
            display->origin_y + src.top,
            guac_rect_width(&src), guac_rect_height(&src));
    guac_rect_constrain(&dst, &context->bounds);

    int width = guac_rect_width(&dst);
    int height = guac_rect_height(&dst);
    if (width <= 0 || height <= 0)
        return;

    /* Source origin corresponding to the (possibly clamped) destination */
    int src_x = dst.left - display->origin_x;
    int src_y = dst.top - display->origin_y;

    /* The SPICE primary surface (SPICE_SURFACE_FMT_32_xRGB) shares the same
     * little-endian 32-bit memory layout as the Guacamole raw layer buffer, so
     * each row can be copied directly. */
    unsigned char* dst_row = GUAC_RECT_MUTABLE_BUFFER(dst,
            context->buffer, context->stride, GUAC_DISPLAY_LAYER_RAW_BPP);

    const unsigned char* src_row = surface
            + (size_t) src_y * display->stride
            + (size_t) src_x * GUAC_DISPLAY_LAYER_RAW_BPP;

    size_t row_length = (size_t) width * GUAC_DISPLAY_LAYER_RAW_BPP;

    if (swap_red_blue) {
        for (int row = 0; row < height; row++) {
            for (int col = 0; col < width; col++) {
                const unsigned char* sp = src_row + (size_t) col * GUAC_DISPLAY_LAYER_RAW_BPP;
                unsigned char* dp = dst_row + (size_t) col * GUAC_DISPLAY_LAYER_RAW_BPP;
                dp[0] = sp[2];
                dp[1] = sp[1];
                dp[2] = sp[0];
                dp[3] = sp[3];
            }
            dst_row += context->stride;
            src_row += display->stride;
        }
    }
    else {
        for (int row = 0; row < height; row++) {
            memcpy(dst_row, src_row, row_length);
            dst_row += context->stride;
            src_row += display->stride;
        }
    }

    /* Mark the modified region as dirty */
    guac_rect_extend(&context->dirty, &dst);

}

/**
 * Sends the current monitor layout to the connected client as a JSON
 * "multimon-layout" parameter on the default layer, allowing a multi-monitor
 * client to split the combined framebuffer into per-monitor windows. Does
 * nothing unless multi-monitor support is enabled for this connection. Must be
 * called with surface_lock held, on the SPICE event-loop thread.
 *
 * The layout enumerates the heads of every active display channel. Each head is
 * numbered sequentially (so a guest exposing several display channels, each
 * with head id 0, still yields a contiguous set of monitor indices) and is
 * positioned within the combined layer by the owning channel's origin. Where a
 * channel reports its own monitor regions (a single channel may itself expose
 * several heads within one combined surface), those regions are used, clamped
 * to the channel's surface; otherwise the whole surface is treated as one head.
 *
 * @param client
 *     The guac_client whose monitor layout should be published.
 */
static void guac_spice_display_publish_layout(guac_client* client) {

    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    /* Only relevant when multi-monitor support is enabled for this connection */
    if (spice_client->settings->max_secondary_monitors <= 0)
        return;

    char json[GUAC_SPICE_MULTIMON_LAYOUT_SIZE];
    int pos = 0;
    int written = 0;
    int index = 0;

    /* Count active display channels. Multiple channels means each channel's
     * surface is a single monitor (e.g. a Windows multi-QXL guest); a single
     * channel may instead carry several monitor regions within one combined
     * surface (e.g. a Linux multi-head QXL). These need opposite positioning. */
    int active = 0;
    for (int i = 0; i < GUAC_SPICE_MAX_MONITORS; i++) {
        guac_spice_display_state* d = &spice_client->displays[i];
        if (d->channel != NULL && d->data != NULL && d->width > 0 && d->height > 0)
            active++;
    }

    json[pos++] = '{';

    for (int i = 0; i < GUAC_SPICE_MAX_MONITORS; i++) {

        guac_spice_display_state* display = &spice_client->displays[i];
        if (display->channel == NULL || display->data == NULL
                || display->width <= 0 || display->height <= 0)
            continue;

        /* Multiple display channels: each channel's surface IS one monitor,
         * placed at its composited origin (exactly where the compositor blits
         * it). The guest's per-channel monitor x/y describe its OWN desktop
         * arrangement, which need not match our left-to-right tiling and can
         * even fall outside the channel's own surface — adding them on top of
         * the origin sends a rearranged secondary head far off-canvas with a
         * clamped sliver width. So publish the whole surface at the origin. */
        if (active > 1) {
            int next = guac_spice_layout_append(json, pos, sizeof(json),
                    written, index, display->origin_x, display->origin_y,
                    display->width, display->height);
            if (next >= 0) { pos = next; written++; index++; }
            continue;
        }

        /* Single display channel: its combined surface may itself hold several
         * monitor regions — split it using the guest-reported regions, which in
         * this case ARE offsets within this one surface. */
        GArray* monitors = NULL;
        g_object_get(SPICE_DISPLAY_CHANNEL(display->channel), "monitors",
                &monitors, NULL);

        int channel_heads = 0;
        if (monitors != NULL) {

            for (guint m = 0; m < monitors->len; m++) {

                SpiceDisplayMonitorConfig* config =
                        &g_array_index(monitors, SpiceDisplayMonitorConfig, m);

                /* SpiceDisplayMonitorConfig coordinates are unsigned. Trim the
                 * guest-reported region to the channel surface using
                 * subtraction ordered to avoid signed overflow: a head whose
                 * origin is at or beyond a surface bound is treated as
                 * disabled. */
                guint gx = config->x, gy = config->y;
                guint gw = config->width, gh = config->height;

                if (gx >= (guint) display->width
                        || gy >= (guint) display->height)
                    continue;

                int left = (int) gx;
                int top = (int) gy;
                int width = (gw > (guint) (display->width - left))
                        ? display->width - left : (int) gw;
                int height = (gh > (guint) (display->height - top))
                        ? display->height - top : (int) gh;

                if (width <= 0 || height <= 0)
                    continue;

                int next = guac_spice_layout_append(json, pos, sizeof(json),
                        written, index, display->origin_x + left,
                        display->origin_y + top, width, height);
                if (next < 0)
                    break;

                pos = next;
                written++;
                index++;
                channel_heads++;

            }

            g_clear_pointer(&monitors, g_array_unref);

        }

        /* No usable guest-reported head for this channel — publish its whole
         * surface as a single monitor */
        if (channel_heads == 0) {
            int next = guac_spice_layout_append(json, pos, sizeof(json),
                    written, index, display->origin_x, display->origin_y,
                    display->width, display->height);
            if (next >= 0) {
                pos = next;
                written++;
                index++;
            }
        }

    }

    /* Nothing to publish (no active display surfaces yet) */
    if (!written) {
        guac_client_log(client, GUAC_LOG_DEBUG, "multimon-layout: nothing to "
                "publish (no active display surfaces)");
        return;
    }

    /* Terminate the JSON object, leaving room for '}' and the null terminator */
    if (pos > (int) sizeof(json) - 2)
        pos = (int) sizeof(json) - 2;
    json[pos++] = '}';
    json[pos] = '\0';

    /* Set the layout parameter on the default layer (layer 0) */
    guac_protocol_send_set(client->socket, GUAC_DEFAULT_LAYER,
            GUAC_PROTOCOL_LAYER_PARAMETER_MULTIMON_LAYOUT, json);
    guac_socket_flush(client->socket);

    guac_client_log(client, GUAC_LOG_DEBUG,
            "multimon-layout published (%d monitor(s)): %s", written, json);

}

/**
 * Recomputes the placement of every active display channel within the combined
 * default layer, resizes that layer to the new bounding box, composites each
 * active channel's full surface into place, and publishes the resulting
 * multi-monitor layout to the client. Active channels are tiled left to right
 * in channel-id order. Must be called with surface_lock held, on the SPICE
 * event-loop thread.
 *
 * @param client
 *     The guac_client whose combined display should be recomposed.
 */
static void guac_spice_display_recompute(guac_client* client) {

    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    /* Assign each active channel an origin, tiling left-to-right in channel-id
     * order; the combined layer is the bounding box of all surfaces. */
    int origin_x = 0;
    int combined_width = 0;
    int combined_height = 0;

    for (int i = 0; i < GUAC_SPICE_MAX_MONITORS; i++) {
        guac_spice_display_state* display = &spice_client->displays[i];
        if (display->data == NULL || display->width <= 0 || display->height <= 0)
            continue;
        display->origin_x = origin_x;
        display->origin_y = 0;
        origin_x += display->width;
        combined_width = origin_x;
        if (display->height > combined_height)
            combined_height = display->height;
    }

    spice_client->combined_width = combined_width;
    spice_client->combined_height = combined_height;

    /* Nothing to composite (no active surfaces), or display not yet started */
    if (spice_client->display == NULL
            || combined_width <= 0 || combined_height <= 0)
        return;

    /* Guard against implausible combined dimensions (defense-in-depth against
     * an oversized allocation; CWE-400/CWE-789) */
    if (combined_width > GUAC_DISPLAY_MAX_WIDTH
            || combined_height > GUAC_DISPLAY_MAX_HEIGHT)
        return;

    guac_display_layer* default_layer =
            guac_display_default_layer(spice_client->display);

    /* Size the combined layer to fit every head, then composite each active
     * surface into its assigned position */
    guac_display_layer_resize(default_layer, combined_width, combined_height);

    guac_display_layer_raw_context* context =
            guac_display_layer_open_raw(default_layer);

    for (int i = 0; i < GUAC_SPICE_MAX_MONITORS; i++) {
        guac_spice_display_state* display = &spice_client->displays[i];
        if (display->data == NULL || display->width <= 0 || display->height <= 0)
            continue;
        guac_spice_composite_region(context, display, 0, 0,
                display->width, display->height,
                spice_client->settings->swap_red_blue);
    }

    guac_display_layer_close_raw(default_layer, context);
    guac_display_render_thread_notify_modified(spice_client->render_thread);

    /* Publish the resulting monitor layout to the client */
    guac_spice_display_publish_layout(client);

}

/**
 * Signal handler for the SPICE display channel "display-primary-create"
 * signal. Records the location and dimensions of the new primary surface for
 * the originating display channel and recomposes the combined display.
 */
static void guac_spice_display_primary_create(SpiceChannel* channel,
        gint format, gint width, gint height, gint stride, gint shmid,
        gpointer imgdata, gpointer data) {

    guac_client* client = (guac_client*) data;
    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    pthread_mutex_lock(&spice_client->surface_lock);

    guac_spice_display_state* display =
            guac_spice_display_slot(spice_client, channel);
    if (display == NULL) {
        pthread_mutex_unlock(&spice_client->surface_lock);
        guac_client_log(client, GUAC_LOG_WARNING, "Ignoring SPICE display "
                "channel with id beyond the supported %d monitors.",
                GUAC_SPICE_MAX_MONITORS);
        return;
    }

    guac_client_log(client, GUAC_LOG_DEBUG,
            "SPICE primary surface created on display %d: %dx%d "
            "(stride %d, format %d).",
            guac_spice_display_channel_id(channel), width, height, stride,
            format);

    /* Record the new primary surface for this channel, guarding against
     * implausible server-supplied dimensions (defense-in-depth against an
     * oversized allocation; CWE-400/CWE-789) */
    display->channel = channel;
    if (width > 0 && height > 0
            && width <= GUAC_DISPLAY_MAX_WIDTH
            && height <= GUAC_DISPLAY_MAX_HEIGHT) {
        display->data = imgdata;
        display->format = format;
        display->width = width;
        display->height = height;
        display->stride = stride;
    }
    else {
        display->data = NULL;
        display->width = 0;
        display->height = 0;
        display->stride = 0;
    }

    /* Recompose the combined layer to include the new surface and publish the
     * updated monitor layout */
    guac_spice_display_recompute(client);

    /* The display is now ready to receive a guest resize; flush any queued
     * client-requested resize that was waiting on the primary surface */
    spice_client->resize_display_ready = 1;

    pthread_mutex_unlock(&spice_client->surface_lock);

    guac_spice_resize_try(client);

}

/**
 * Signal handler for the SPICE display channel "display-primary-destroy"
 * signal. Clears the recorded primary surface for the originating channel,
 * preventing any further reads from the (now invalid) surface buffer, and
 * recomposes the combined display without it.
 */
static void guac_spice_display_primary_destroy(SpiceChannel* channel,
        gpointer data) {

    guac_client* client = (guac_client*) data;
    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    pthread_mutex_lock(&spice_client->surface_lock);

    guac_spice_display_state* display =
            guac_spice_display_slot(spice_client, channel);
    if (display != NULL) {
        display->data = NULL;
        display->width = 0;
        display->height = 0;
        display->stride = 0;
    }

    /* Recompose the combined layer without the destroyed surface */
    guac_spice_display_recompute(client);

    pthread_mutex_unlock(&spice_client->surface_lock);

}

/**
 * Signal handler for the SPICE display channel "display-invalidate" signal.
 * Composites the damaged region of the originating channel's primary surface
 * into that channel's position within the combined Guacamole display.
 */
static void guac_spice_display_invalidate(SpiceChannel* channel,
        gint x, gint y, gint w, gint h, gpointer data) {

    guac_client* client = (guac_client*) data;
    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    if (spice_client->display == NULL)
        return;

    pthread_mutex_lock(&spice_client->surface_lock);

    /* Ignore updates for a channel with no current primary surface */
    guac_spice_display_state* display =
            guac_spice_display_slot(spice_client, channel);
    if (display == NULL || display->data == NULL) {
        pthread_mutex_unlock(&spice_client->surface_lock);
        return;
    }

    guac_display_layer* default_layer =
            guac_display_default_layer(spice_client->display);

    /* Acquire exclusive access to the layer for drawing */
    guac_display_layer_raw_context* context =
            guac_display_layer_open_raw(default_layer);

    /* Composite the damaged region into this channel's assigned position */
    guac_spice_composite_region(context, display, x, y, w, h,
            spice_client->settings->swap_red_blue);

    pthread_mutex_unlock(&spice_client->surface_lock);

    /* Drawing is complete */
    guac_display_layer_close_raw(default_layer, context);
    guac_display_render_thread_notify_modified(spice_client->render_thread);

}

/**
 * Signal handler for the SPICE display channel "notify::monitors" signal,
 * fired whenever the guest publishes a new monitor configuration. Recomposes
 * and re-publishes the combined layout so that a repositioning which does not
 * recreate a primary surface is still reflected on the client.
 */
static void guac_spice_display_monitors_updated(SpiceChannel* channel,
        GParamSpec* pspec, gpointer data) {

    guac_client* client = (guac_client*) data;
    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    pthread_mutex_lock(&spice_client->surface_lock);
    guac_spice_display_recompute(client);
    pthread_mutex_unlock(&spice_client->surface_lock);

}

void guac_spice_display_channel_connect(guac_client* client,
        SpiceChannel* channel) {

    guac_spice_client* spice_client = (guac_spice_client*) client->data;
    spice_client->display_channel = channel;

    /* Mirror the remote framebuffer of this display channel into the Guacamole
     * display. Each display channel delivers its own primary-surface and
     * invalidate signals; the handlers identify the originating channel and
     * composite it into the combined layer accordingly. */
    g_signal_connect(channel, "display-primary-create",
            G_CALLBACK(guac_spice_display_primary_create), client);
    g_signal_connect(channel, "display-primary-destroy",
            G_CALLBACK(guac_spice_display_primary_destroy), client);
    g_signal_connect(channel, "display-invalidate",
            G_CALLBACK(guac_spice_display_invalidate), client);

    /* Re-publish the monitor layout whenever the guest changes its monitor
     * configuration, keeping the client's per-monitor split in sync with the
     * guest's actual geometry even without a primary-surface recreate */
    g_signal_connect(channel, "notify::monitors",
            G_CALLBACK(guac_spice_display_monitors_updated), client);

}

void guac_spice_display_channel_disconnect(guac_client* client,
        SpiceChannel* channel) {

    guac_spice_client* spice_client = (guac_spice_client*) client->data;

    pthread_mutex_lock(&spice_client->surface_lock);

    /* Clear this channel's slot only if it has not already been reclaimed by a
     * newly-connected channel with the same id */
    guac_spice_display_state* display =
            guac_spice_display_slot(spice_client, channel);
    if (display != NULL && display->channel == channel) {
        display->channel = NULL;
        display->data = NULL;
        display->width = 0;
        display->height = 0;
        display->stride = 0;
    }

    /* Recompose the combined layer without the departed channel */
    guac_spice_display_recompute(client);

    pthread_mutex_unlock(&spice_client->surface_lock);

}
