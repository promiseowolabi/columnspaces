//! The browser and these tests run the same five checks (see src/lib.rs).

use zone_maps as lab;

macro_rules! lab_test {
    ($name:ident, $check:expr) => {
        #[test]
        fn $name() {
            let c = $check;
            assert!(c.pass, "[{}] {} — {}", c.id, c.label, c.msg);
        }
    };
}

lab_test!(stats_exact, lab::check_stats_exact());
lab_test!(no_false_negatives, lab::check_no_false_negatives());
lab_test!(prunes_target, lab::check_prunes_target());
lab_test!(null_semantics, lab::check_null_semantics());
lab_test!(storm, lab::check_storm());
