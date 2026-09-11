//! The browser and these tests run the same five checks (see src/lib.rs).

use shuffle as lab;

macro_rules! lab_test {
    ($name:ident, $check:expr) => {
        #[test]
        fn $name() {
            let c = $check;
            assert!(c.pass, "[{}] {} — {}", c.id, c.label, c.msg);
        }
    };
}

lab_test!(join_correct, lab::check_join_correct());
lab_test!(bytes_shuffled, lab::check_bytes_shuffled());
lab_test!(broadcast_choice, lab::check_broadcast_choice());
lab_test!(skew_bounded, lab::check_skew_bounded());
lab_test!(storm, lab::check_storm());
