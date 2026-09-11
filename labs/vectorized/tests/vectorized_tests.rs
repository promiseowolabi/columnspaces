//! The browser and these tests run the same five checks (see src/lib.rs).

use vectorized as lab;

macro_rules! lab_test {
    ($name:ident, $check:expr) => {
        #[test]
        fn $name() {
            let c = $check;
            assert!(c.pass, "[{}] {} — {}", c.id, c.label, c.msg);
        }
    };
}

lab_test!(filter_matches_scalar, lab::check_filter_matches_scalar());
lab_test!(selection_vector, lab::check_selection_vector());
lab_test!(aggregate_correct, lab::check_aggregate_correct());
lab_test!(compressed_path, lab::check_compressed_path());
lab_test!(storm, lab::check_storm());
