/*
 * AppleMusicControls for Vencord
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Slider wrapper follows the same approach used by Vencord's SpotifyControls.
 */

import { LazyComponent } from "@utils/lazyReact";
import { Slider } from "@webpack/common";

export const SeekBar = LazyComponent(() => {
    const SliderClass = Slider.$$vencordGetWrappedComponent();

    return class SeekBar extends SliderClass {
        static getDerivedStateFromProps(props: any, state: any) {
            const newState = super.getDerivedStateFromProps!(props, state);
            if (newState) newState.value = props.initialValue;
            return newState;
        }
    };
});
